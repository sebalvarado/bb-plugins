import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNNING_WINDOW_MS,
  STOPPED_AFTER_MS,
  agentIdFromFileName,
  delegationTitle,
  describeTool,
  finishedFromTail,
  isFinishedLine,
  isUuid,
  matchDelegations,
  parseLine,
  parseTranscript,
  stateOf,
  summariseTranscript,
  titleFromPrompt,
  type AgentFile,
  type Delegation,
} from "./subagents.ts";

const user = (text: string) => JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });
const said = (text: string) => JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });
const called = (text: string | null, ...tools: { name: string; input: Record<string, unknown> }[]) =>
  JSON.stringify({
    role: "assistant",
    message: {
      content: [
        ...(text === null ? [] : [{ type: "text", text }]),
        ...tools.map((tool) => ({ type: "tool_use", ...tool })),
      ],
    },
  });

const PROMPT = "<timestamp>Monday, Jan 5, 2026, 9:00 AM (UTC-5)</timestamp>\n<user_query>\nBuild the widget.\nUse the blue paint.\n</user_query>";
const FOLLOW_UP = "<timestamp>Monday, Jan 5, 2026, 9:40 AM (UTC-5)</timestamp>\n<user_query>\nAlso paint the lid.\n</user_query>";

const transcript = [
  user(PROMPT),
  called("Reading the brief.", { name: "Read", input: { path: "/tmp/brief.md" } }),
  called(null, { name: "Shell", input: { command: "make widget", description: "Build the widget" } }),
  user(FOLLOW_UP),
  called("Painting.", { name: "StrReplace", input: { path: "/tmp/lid.txt", old_string: "a", new_string: "b" } }),
  said("Done: the widget and its lid are blue."),
].join("\n");

test("a transcript whose last line is assistant text without a tool call is finished, with that text as its report", () => {
  const result = summariseTranscript(parseTranscript(transcript));
  assert.equal(result.finished, true);
  assert.equal(result.report, "Done: the widget and its lid are blue.");
  assert.equal(stateOf(result.finished, 0, 10 * RUNNING_WINDOW_MS), "finished");
});

test("an unfinished transcript is running while its file changed in the window, stalled after", () => {
  const lines = parseTranscript([user(PROMPT), called("Working.", { name: "Read", input: { path: "/tmp/a" } })].join("\n"));
  const result = summariseTranscript(lines);
  assert.equal(result.finished, false);
  assert.equal(result.report, null);
  const modifiedAt = 1_000_000;
  assert.equal(stateOf(false, modifiedAt, modifiedAt + RUNNING_WINDOW_MS), "running");
  assert.equal(stateOf(false, modifiedAt, modifiedAt + RUNNING_WINDOW_MS + 1), "stalled");
});

test("an unfinished transcript with no step for a day is stopped, while a finished one stays finished", () => {
  const modifiedAt = 1_000_000;
  assert.equal(stateOf(false, modifiedAt, modifiedAt + STOPPED_AFTER_MS), "stalled");
  assert.equal(stateOf(false, modifiedAt, modifiedAt + STOPPED_AFTER_MS + 1), "stopped");
  assert.equal(stateOf(true, modifiedAt, modifiedAt + 10 * STOPPED_AFTER_MS), "finished");
});

test("a last line that is a user message or carries a tool call is not finished", () => {
  assert.equal(isFinishedLine(parseLine(user(FOLLOW_UP))), false);
  assert.equal(isFinishedLine(parseLine(called("Next.", { name: "Read", input: { path: "/x" } }))), false);
  assert.equal(isFinishedLine(parseLine("{not json")), false);
});

test("the end of a transcript decides finished from its last message, skipping bookkeeping lines", () => {
  const ended = `${transcript}\n${JSON.stringify({ type: "turn_ended", status: "success" })}\n`;
  assert.equal(summariseTranscript(parseTranscript(ended)).finished, true);
  assert.equal(finishedFromTail(ended, true), true);
  assert.equal(finishedFromTail(ended.slice(-200), false), true);
  const working = `${user(PROMPT)}\n${called("Working.", { name: "Read", input: { path: "/tmp/a" } })}\n`;
  assert.equal(finishedFromTail(working, true), false);
  assert.equal(finishedFromTail('ial line"}]}}\n{"type":"turn_ended"}\n', false), null);
  assert.equal(finishedFromTail("", true), false);
});

test("the prompt and every follow-up are extracted without their timestamp and query wrappers", () => {
  const result = summariseTranscript(parseTranscript(transcript));
  assert.deepEqual(result.prompt, { sentAt: "Monday, Jan 5, 2026, 9:00 AM (UTC-5)", text: "Build the widget.\nUse the blue paint." });
  assert.deepEqual(result.followUps, [{ sentAt: "Monday, Jan 5, 2026, 9:40 AM (UTC-5)", text: "Also paint the lid." }]);
  assert.equal(titleFromPrompt(result.prompt), "Build the widget.");
});

test("the last steps summarise tool calls, oldest first, keeping only the most recent", () => {
  const result = summariseTranscript(parseTranscript(transcript));
  assert.deepEqual(result.lastSteps, ["Read: /tmp/brief.md", "Shell: Build the widget", "StrReplace: /tmp/lid.txt"]);
  assert.deepEqual(summariseTranscript(parseTranscript(transcript), 1).lastSteps, ["StrReplace: /tmp/lid.txt"]);
  assert.equal(describeTool({ name: "Mystery", input: { count: 3 } }), "Mystery");
});

test("each delegation matches the agent file born closest after it within a minute; others stay unmatched", () => {
  const delegations: Delegation[] = [
    { id: "d1", title: "First", createdAt: 10_000, status: "completed" },
    { id: "d2", title: "Second", createdAt: 12_000, status: "completed" },
    { id: "d3", title: "Resumed", createdAt: 500_000, status: "completed" },
  ];
  const files: AgentFile[] = [
    { agentId: "b", bornAt: 19_000, modifiedAt: 0 },
    { agentId: "a", bornAt: 15_000, modifiedAt: 0 },
    { agentId: "early", bornAt: 9_000, modifiedAt: 0 },
    { agentId: "late", bornAt: 200_000, modifiedAt: 0 },
  ];
  const matched = matchDelegations(delegations, files);
  assert.equal(matched.get("a")?.id, "d1");
  assert.equal(matched.get("b")?.id, "d2");
  assert.equal(matched.has("early"), false);
  assert.equal(matched.has("late"), false);
  assert.equal(delegationTitle("Task: Paint the lid"), "Paint the lid");
});

test("delegations launched together match the file whose prompt names them, whatever order the files appear in", () => {
  const delegations: Delegation[] = [
    { id: "d1", title: "Paint the garden fence", createdAt: 1_000, status: "completed" },
    { id: "d2", title: "Fix the kitchen tap", createdAt: 2_000, status: "completed" },
    { id: "d3", title: "Sweep the attic", createdAt: 3_000, status: "completed" },
  ];
  const files: AgentFile[] = [
    { agentId: "x", bornAt: 8_000, modifiedAt: 0, promptLine: "You are a helper. Your folder is /work/kitchen-tap (branch kitchen-tap)." },
    { agentId: "y", bornAt: 9_000, modifiedAt: 0, promptLine: "You are a helper. Your folder is /work/attic-sweep (branch attic-sweep)." },
    { agentId: "z", bornAt: 10_000, modifiedAt: 0, promptLine: "You are a helper. Your folder is /work/garden-fence (branch garden-fence)." },
  ];
  const matched = matchDelegations(delegations, files);
  assert.equal(matched.get("x")?.id, "d2");
  assert.equal(matched.get("y")?.id, "d3");
  assert.equal(matched.get("z")?.id, "d1");
});

test("short common words in a title do not pull a delegation away from the file born after it", () => {
  const delegations: Delegation[] = [
    { id: "d1", title: "Count bolts and nuts", createdAt: 1_000, status: "completed" },
    { id: "d2", title: "Count screws", createdAt: 13_000, status: "completed" },
  ];
  const files: AgentFile[] = [
    { agentId: "first", bornAt: 8_000, modifiedAt: 0, promptLine: "Read the shelf list." },
    { agentId: "second", bornAt: 20_000, modifiedAt: 0, promptLine: "Read the shelf and the drawer list." },
  ];
  const matched = matchDelegations(delegations, files);
  assert.equal(matched.get("first")?.id, "d1");
  assert.equal(matched.get("second")?.id, "d2");
});

test("only a UUID is accepted as a conversation id, and only <uuid>.jsonl as an agent file", () => {
  const id = "05febc70-0000-4000-8000-000000000001";
  assert.equal(isUuid(id), true);
  assert.equal(isUuid("../../etc"), false);
  assert.equal(isUuid(`${id}/..`), false);
  assert.equal(agentIdFromFileName(`${id}.jsonl`), id);
  assert.equal(agentIdFromFileName(`${id}.json`), null);
  assert.equal(agentIdFromFileName("../secret.jsonl"), null);
  assert.equal(agentIdFromFileName(".jsonl"), null);
});
