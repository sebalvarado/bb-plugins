export const RUNNING_WINDOW_MS = 3 * 60_000;
export const STOPPED_AFTER_MS = 24 * 60 * 60_000;
export const MATCH_WINDOW_MS = 60_000;
export const LAST_STEPS = 8;

export type State = "running" | "finished" | "stalled" | "stopped";

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface Line {
  role: "user" | "assistant";
  texts: string[];
  tools: ToolCall[];
}

export interface Message {
  sentAt: string | null;
  text: string;
}

export interface Transcript {
  prompt: Message | null;
  followUps: Message[];
  lastSteps: string[];
  report: string | null;
  finished: boolean;
}

export interface Delegation {
  id: string;
  title: string;
  createdAt: number;
  status: "pending" | "completed" | "failed" | "interrupted";
}

export interface AgentFile {
  agentId: string;
  bornAt: number;
  modifiedAt: number;
  promptLine?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function agentIdFromFileName(name: string): string | null {
  if (!name.endsWith(".jsonl")) return null;
  const id = name.slice(0, -".jsonl".length);
  return isUuid(id) ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLine(raw: string): Line | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) return null;
  const content = isRecord(value.message) && Array.isArray(value.message.content) ? value.message.content : [];
  const line: Line = { role: value.role, texts: [], tools: [] };
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") line.texts.push(block.text);
    if (block.type === "tool_use" && typeof block.name === "string") {
      line.tools.push({ name: block.name, input: isRecord(block.input) ? block.input : {} });
    }
  }
  return line;
}

export function parseTranscript(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const line = parseLine(raw);
    if (line !== null) lines.push(line);
  }
  return lines;
}

export function isFinishedLine(line: Line | null): boolean {
  return line !== null && line.role === "assistant" && line.texts.length > 0 && line.tools.length === 0;
}

/**
 * Whether the last message in the end of a transcript is finished; null when that end holds no whole
 * message line, so a longer end must be read. `fromStart` says the text begins at the file's first byte.
 */
export function finishedFromTail(tail: string, fromStart: boolean): boolean | null {
  const lines = tail.split("\n");
  if (!fromStart) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim() === "" ? null : parseLine(lines[index]);
    if (line !== null) return isFinishedLine(line);
  }
  return fromStart ? false : null;
}

export function stateOf(finished: boolean, modifiedAt: number, now: number): State {
  if (finished) return "finished";
  const idle = now - modifiedAt;
  if (idle <= RUNNING_WINDOW_MS) return "running";
  return idle <= STOPPED_AFTER_MS ? "stalled" : "stopped";
}

export function userMessage(text: string): Message {
  let rest = text;
  let sentAt: string | null = null;
  const stamp = /^\s*<timestamp>([\s\S]*?)<\/timestamp>\s*/.exec(rest);
  if (stamp) {
    sentAt = stamp[1].trim();
    rest = rest.slice(stamp[0].length);
  }
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(rest);
  return { sentAt, text: (query ? query[1] : rest).trim() };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const TOOL_DETAIL = ["description", "path", "command", "pattern", "glob_pattern", "toolName", "query", "url"];

export function describeTool(tool: ToolCall): string {
  for (const field of TOOL_DETAIL) {
    const value = tool.input[field];
    if (typeof value === "string" && value.trim() !== "") return oneLine(`${tool.name}: ${value}`, 140);
  }
  return tool.name;
}

export function summariseTranscript(lines: Line[], steps = LAST_STEPS): Transcript {
  const users = lines.filter((line) => line.role === "user" && line.texts.length > 0);
  const messages = users.map((line) => userMessage(line.texts.join("\n\n")));
  const tools = lines.flatMap((line) => (line.role === "assistant" ? line.tools : []));
  const last = lines.at(-1) ?? null;
  const finished = isFinishedLine(last);
  return {
    prompt: messages[0] ?? null,
    followUps: messages.slice(1),
    lastSteps: tools.slice(-steps).map(describeTool),
    report: finished && last ? last.texts.join("\n\n") : null,
    finished,
  };
}

export function delegationTitle(label: string): string {
  return label.replace(/^Task:\s*/, "").trim() || label;
}

export function promptLine(prompt: Message | null): string {
  return prompt?.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

export function titleFromPrompt(prompt: Message | null): string {
  const first = promptLine(prompt);
  return first ? oneLine(first, 80) : "Untitled subagent";
}

const STOP_WORDS = new Set(["from", "into", "than", "that", "them", "then", "they", "this", "what", "when", "with", "your"]);

function words(text: string): Set<string> {
  const all = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(all.filter((word) => word.length >= 4 && !STOP_WORDS.has(word)));
}

/**
 * Pairs each delegation, oldest first, with an unclaimed agent file born after it within the window.
 * Among several, it takes the one whose first prompt line holds the most title words the others lack,
 * which tells apart subagents launched together; on a tie, the one born closest after it.
 */
export function matchDelegations(delegations: Delegation[], files: AgentFile[]): Map<string, Delegation> {
  const matched = new Map<string, Delegation>();
  const ordered = [...delegations].sort((a, b) => a.createdAt - b.createdAt);
  for (const delegation of ordered) {
    const eligible = files.filter((file) => {
      const gap = file.bornAt - delegation.createdAt;
      return !matched.has(file.agentId) && gap >= 0 && gap <= MATCH_WINDOW_MS;
    });
    if (eligible.length === 0) continue;
    const promptWords = eligible.map((file) => words(file.promptLine ?? ""));
    const title = [...words(delegation.title)].filter((word) => !promptWords.every((set) => set.has(word)));
    const scored = eligible.map((file, index) => ({
      file,
      score: title.filter((word) => promptWords[index].has(word)).length,
    }));
    scored.sort((a, b) => b.score - a.score || a.file.bornAt - b.file.bornAt);
    matched.set(scored[0].file.agentId, delegation);
  }
  return matched;
}
