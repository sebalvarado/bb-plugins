import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NEEDS_YOU, begin, boardOptions, checks, enabled, parseLifecycle, stage, stagePrompt, transition, type Event, type Run } from "./lifecycle.ts";

const def = parseLifecycle(readFileSync(new URL("../../.bb/lifecycle.json", import.meta.url), "utf8"));
const NOW = "2026-11-14T05:00:00.000Z";

function started(): Run {
  return begin(def, { ref: "example/repo#3", repo: "example/repo", number: 3, title: "Epic: Move money", projectId: "P", itemId: "I", pr: null, implementer: null, reviewer: null }, NOW).run;
}

function walk(run: Run, ...events: Event[]) {
  let result = { run, action: { type: "finished" } as ReturnType<typeof transition>["action"] };
  for (const event of events) result = transition(def, result.run, event, NOW);
  return result;
}

const done = (extra: Partial<Extract<Event, { type: "done" }>> = {}): Event => ({ type: "done", note: "did it", ...extra });

const toReview = () => walk(started(), done(), done(), { type: "approve" }, done(), done({ pr: 40 }));

test("the repository's lifecycle parses, with rollout and monitoring defined but off", () => {
  assert.deepEqual(
    enabled(def).map((s) => s.id),
    ["triage", "plan", "plan-approval", "build", "pull-request", "review", "address", "ready-to-merge", "merged"],
  );
  assert.equal(stage(def, "monitoring")?.enabled, false);
  assert.equal(def.reviewRounds, 3);
  assert.deepEqual(boardOptions(def).slice(-3), ["Rolling out", "Monitoring", "Needs you"]);
});

test("a run starts at triage with the implementer, and plans before it waits for approval", () => {
  const { run, action } = begin(def, { ref: "a/b#1", repo: "a/b", number: 1, title: "t", projectId: null, itemId: null, pr: null, implementer: null, reviewer: null }, NOW);
  assert.equal(run.stage, "triage");
  assert.equal(action.type === "send" && action.actor, "implementer");
  const planned = walk(run, done(), done());
  assert.equal(planned.run.stage, "plan-approval");
  assert.equal(planned.action.type, "wait");
});

test("only the maintainer passes a gate, and sending back returns the note to the plan", () => {
  const atGate = walk(started(), done(), done()).run;
  assert.throws(() => transition(def, atGate, done(), NOW), /waits for your approval/);
  const back = transition(def, atGate, { type: "send-back", note: "split the second slice" }, NOW);
  assert.equal(back.run.stage, "plan");
  assert.equal(back.action.type === "send" && back.action.note, "split the second slice");
  assert.equal(transition(def, atGate, { type: "approve" }, NOW).run.stage, "build");
});

test("an agent stage refuses approval, and the pull request stage must name its pull request", () => {
  const building = walk(started(), done(), done(), { type: "approve" }).run;
  assert.throws(() => transition(def, building, { type: "approve" }, NOW), /agent's to finish/);
  const atPr = transition(def, building, done(), NOW).run;
  assert.throws(() => transition(def, atPr, done(), NOW), /--pr/);
  const review = transition(def, atPr, done({ pr: 40 }), NOW);
  assert.equal(review.run.pr, 40);
  assert.equal(review.run.stage, "review");
  assert.equal(review.action.type === "send" && review.action.actor, "reviewer");
});

test("must findings loop through address review until a round has none", () => {
  const atReview = toReview().run;
  assert.throws(() => transition(def, atReview, done(), NOW), /--must/);
  const first = transition(def, atReview, done({ must: 2 }), NOW);
  assert.equal(first.run.stage, "address");
  assert.equal(first.run.round, 1);
  assert.equal(first.action.type === "send" && first.action.actor, "implementer");
  const second = walk(first.run, done(), done({ must: 0 }));
  assert.equal(second.run.stage, "ready-to-merge");
  assert.equal(second.run.round, 2);
  assert.equal(second.action.type, "wait");
});

test("after the last review round with must findings it stops for the maintainer, who can resume it", () => {
  const stuck = walk(toReview().run, done({ must: 1 }), done(), done({ must: 1 }), done(), done({ must: 1 }));
  assert.equal(stuck.run.stage, NEEDS_YOU);
  assert.equal(stuck.run.stoppedAt, "address");
  assert.equal(stuck.run.round, 3);
  assert.throws(() => transition(def, stuck.run, done(), NOW), /resume it first/);
  const resumed = transition(def, stuck.run, { type: "resume", note: "the reviewer is wrong about finding 2" }, NOW);
  assert.equal(resumed.run.stage, "address");
  assert.equal(resumed.run.round, 0);
});

test("ready to merge ends only with the merge, and sending it back reopens the findings", () => {
  const ready = walk(toReview().run, done({ must: 0 })).run;
  assert.equal(ready.stage, "ready-to-merge");
  assert.throws(() => transition(def, ready, { type: "approve" }, NOW), /when you merge/);
  const merged = transition(def, ready, { type: "merged" }, NOW);
  assert.equal(merged.run.stage, "merged");
  assert.equal(merged.action.type, "finished");
  assert.equal(transition(def, ready, { type: "send-back", note: "rename the table" }, NOW).run.stage, "address");
});

test("a blocked agent stops the run where it was, and resuming picks that stage up again", () => {
  const blocked = transition(def, started(), { type: "blocked", note: "which red goes first?" }, NOW);
  assert.equal(blocked.run.stage, NEEDS_YOU);
  assert.equal(blocked.run.stoppedAt, "triage");
  assert.match(blocked.run.history.at(-1)!.note, /which red goes first/);
  assert.equal(transition(def, blocked.run, { type: "resume" }, NOW).run.stage, "triage");
  assert.throws(() => transition(def, blocked.run, { type: "resume", to: "monitoring" }, NOW), /no stage/);
});

test("pull request checks pass only when every check has finished well", () => {
  assert.equal(checks([]), "passing");
  assert.equal(checks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }]), "passing");
  assert.equal(checks([{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }]), "pending");
  assert.equal(checks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }, { __typename: "CheckRun", status: "QUEUED" }]), "failing");
  assert.equal(checks([{ __typename: "StatusContext", state: "PENDING" }]), "pending");
  assert.equal(checks([{ __typename: "StatusContext", state: "ERROR" }]), "failing");
});

test("each stage's prompt carries its instructions and the exact command to report it", () => {
  const run = started();
  const atPr = walk(run, done(), done(), { type: "approve" }, done()).run;
  const prompt = stagePrompt(def, atPr, stage(def, "pull-request")!, "");
  assert.match(prompt, /^Lifecycle of example\/repo#3: Epic: Move money\nStage 5 of 9: Pull request/);
  assert.match(prompt, /epic-tracking and pr-description-writer/);
  assert.match(prompt, /stage done example\/repo#3 --summary "[^"]+" --pr <number>/);
  const review = stagePrompt(def, { ...atPr, pr: 40 }, stage(def, "review")!, "");
  assert.match(review, /review round 1 of at most 3/);
  assert.match(review, /--must <open must findings>/);
  assert.match(review, /gh pr view 40 -R example\/repo --comments/);
});

test("a lifecycle file that breaks the review loop's shape is refused", () => {
  const broken = JSON.parse(JSON.stringify(def));
  broken.stages = broken.stages.filter((s: { id: string }) => s.id !== "address");
  assert.throws(() => parseLifecycle(JSON.stringify(broken)), /review stage needs an address stage/);
  const noActor = JSON.parse(JSON.stringify(def));
  delete noActor.stages[0].actor;
  assert.throws(() => parseLifecycle(JSON.stringify(noActor)), /needs an agent actor/);
});
