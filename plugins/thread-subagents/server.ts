import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { contract, type Card, type Summary } from "./contract";
import {
  agentIdFromFileName,
  delegationTitle,
  finishedFromTail,
  isUuid,
  matchDelegations,
  parseTranscript,
  promptLine,
  stateOf,
  summariseTranscript,
  titleFromPrompt,
  type AgentFile,
  type Delegation,
  type Transcript,
} from "./subagents";

const PROJECTS_ROOT = join(homedir(), ".cursor", "projects");
const CACHE_MS = 60_000;
const EVENT_PAGE = 100;
const TAIL_START = 64 * 1024;
const TAIL_MAX = 4 * 1024 * 1024;

interface FileEntry extends AgentFile {
  path: string;
  size: number;
}

async function finishedAtEnd(path: string, size: number): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    for (let chunk = TAIL_START; ; chunk *= 4) {
      const start = Math.max(0, size - chunk);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const finished = finishedFromTail(buffer.toString("utf8"), start === 0);
      if (finished !== null) return finished;
      if (chunk >= TAIL_MAX) return false;
    }
  } finally {
    await handle.close();
  }
}

export default function plugin(bb: BbPluginApi) {
  let projects: { at: number; names: string[] } | null = null;
  const identities = new Map<string, { at: number; ids: string[] }>();
  const tails = new Map<string, { modifiedAt: number; size: number; finished: boolean }>();
  const transcripts = new Map<string, { modifiedAt: number; size: number; transcript: Transcript }>();
  const delegations = new Map<string, { afterSeq: number; byId: Map<string, Delegation> }>();
  const delegationReads = new Map<string, Promise<Delegation[]>>();

  async function projectNames(): Promise<string[]> {
    if (projects && Date.now() - projects.at < CACHE_MS) return projects.names;
    const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true }).catch(() => []);
    projects = { at: Date.now(), names: entries.filter((e) => e.isDirectory()).map((e) => e.name) };
    return projects.names;
  }

  async function conversationIds(threadId: string): Promise<string[]> {
    const cached = identities.get(threadId);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.ids;
    const rows = await bb.sdk.threads.events.list({ threadId, types: ["thread/identity"], order: "desc", limit: String(EVENT_PAGE) });
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.type === "thread/identity" && isUuid(row.data.providerThreadId)) ids.add(row.data.providerThreadId);
    }
    identities.set(threadId, { at: Date.now(), ids: [...ids] });
    return [...ids];
  }

  async function agentFiles(threadId: string): Promise<{ found: boolean; files: FileEntry[] }> {
    const ids = await conversationIds(threadId);
    if (ids.length === 0) return { found: false, files: [] };
    const names = await projectNames();
    const files = new Map<string, FileEntry>();
    let found = false;
    for (const id of ids) {
      for (const project of names) {
        const dir = join(PROJECTS_ROOT, project, "agent-transcripts", id, "subagents");
        const entries = await readdir(dir).catch(() => null);
        if (entries === null) continue;
        found = true;
        for (const name of entries) {
          const agentId = agentIdFromFileName(name);
          if (agentId === null || files.has(agentId)) continue;
          const path = join(dir, name);
          const info = await stat(path).catch(() => null);
          if (info === null || !info.isFile()) continue;
          files.set(agentId, { agentId, path, bornAt: info.birthtimeMs, modifiedAt: info.mtimeMs, size: info.size });
        }
      }
    }
    return { found, files: [...files.values()] };
  }

  async function finishedFromTail(file: FileEntry): Promise<boolean> {
    const cached = tails.get(file.path);
    if (cached && cached.modifiedAt === file.modifiedAt && cached.size === file.size) return cached.finished;
    const finished = await finishedAtEnd(file.path, file.size).catch(() => false);
    tails.set(file.path, { modifiedAt: file.modifiedAt, size: file.size, finished });
    return finished;
  }

  async function transcriptOf(file: FileEntry): Promise<Transcript> {
    const cached = transcripts.get(file.path);
    if (cached && cached.modifiedAt === file.modifiedAt && cached.size === file.size) return cached.transcript;
    const transcript = summariseTranscript(parseTranscript(await readFile(file.path, "utf8")));
    transcripts.set(file.path, { modifiedAt: file.modifiedAt, size: file.size, transcript });
    return transcript;
  }

  async function readDelegations(threadId: string): Promise<Delegation[]> {
    const known = delegations.get(threadId) ?? { afterSeq: 0, byId: new Map<string, Delegation>() };
    for (;;) {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["item/started", "item/completed"],
        order: "asc",
        limit: String(EVENT_PAGE),
        ...(known.afterSeq > 0 ? { afterSeq: String(known.afterSeq) } : {}),
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        known.afterSeq = Math.max(known.afterSeq, row.seq);
        if (row.type !== "item/started" && row.type !== "item/completed") continue;
        const item = row.data.item;
        if (item.type !== "delegation") continue;
        const existing = known.byId.get(item.id);
        known.byId.set(item.id, {
          id: item.id,
          title: delegationTitle(item.label),
          createdAt: existing?.createdAt ?? row.createdAt,
          status: item.status,
        });
      }
    }
    delegations.set(threadId, known);
    return [...known.byId.values()];
  }

  function delegationsOf(threadId: string): Promise<Delegation[]> {
    const pending = delegationReads.get(threadId);
    if (pending) return pending;
    const read = readDelegations(threadId).finally(() => delegationReads.delete(threadId));
    delegationReads.set(threadId, read);
    return read;
  }

  async function summary(threadId: string): Promise<Summary> {
    const { files } = await agentFiles(threadId);
    const now = Date.now();
    const out: Summary = { running: 0, stalled: 0, total: files.length };
    for (const file of files) {
      const state = stateOf(await finishedFromTail(file), file.modifiedAt, now);
      if (state === "running") out.running += 1;
      if (state === "stalled") out.stalled += 1;
    }
    return out;
  }

  async function detail(threadId: string): Promise<{ cards: Card[]; transcripts: boolean }> {
    const [{ found, files }, launched] = await Promise.all([agentFiles(threadId), delegationsOf(threadId)]);
    const now = Date.now();
    if (!found) {
      const cards = launched.map<Card>((d) => ({
        id: d.id,
        title: d.title,
        state: d.status === "pending" ? "running" : "finished",
        source: "delegation",
        launchedAt: d.createdAt,
        lastStepAt: null,
        prompt: null,
        followUps: [],
        lastSteps: [],
        report: null,
      }));
      return { cards: cards.sort((a, b) => (b.launchedAt ?? 0) - (a.launchedAt ?? 0)), transcripts: false };
    }
    const read = await Promise.all(files.map(async (file) => ({ file, transcript: await transcriptOf(file) })));
    const matched = matchDelegations(
      launched,
      read.map(({ file, transcript }) => ({ ...file, promptLine: promptLine(transcript.prompt) })),
    );
    const cards: Card[] = [];
    for (const { file, transcript } of read) {
      const delegation = matched.get(file.agentId);
      cards.push({
        id: file.agentId,
        title: delegation?.title ?? titleFromPrompt(transcript.prompt),
        state: stateOf(transcript.finished, file.modifiedAt, now),
        source: "transcript",
        launchedAt: delegation?.createdAt ?? file.bornAt,
        lastStepAt: file.modifiedAt,
        prompt: transcript.prompt,
        followUps: transcript.followUps,
        lastSteps: transcript.lastSteps,
        report: transcript.report,
      });
    }
    const rank = { running: 0, stalled: 1, finished: 2, stopped: 3 } as const;
    cards.sort((a, b) => rank[a.state] - rank[b.state] || (b.launchedAt ?? 0) - (a.launchedAt ?? 0));
    return { cards, transcripts: true };
  }

  bb.rpc.register(contract, {
    summaries: async ({ keys }) => {
      const out: Record<string, Summary> = {};
      await Promise.all(
        keys.map(async (threadId) => {
          out[threadId] = await summary(threadId).catch(() => ({ running: 0, stalled: 0, total: 0 }));
        }),
      );
      return out;
    },
    detail: ({ threadId }) => detail(threadId),
  });
}
