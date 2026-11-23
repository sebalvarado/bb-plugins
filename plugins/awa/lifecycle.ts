import { z } from "zod";

export const LIFECYCLE_FILE = ".bb/lifecycle.json";

const stageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1).max(40),
  kind: z.enum(["work", "gate", "review", "address", "end"]),
  actor: z.enum(["implementer", "reviewer", "you"]).optional(),
  requires: z.enum(["pull-request", "merged"]).optional(),
  sendBackTo: z.string().optional(),
  enabled: z.boolean().default(true),
  instructions: z.string().default(""),
});

export const lifecycleSchema = z
  .object({
    field: z.string().min(1).default("Stage"),
    needsYou: z.string().min(1).default("Needs you"),
    reviewRounds: z.number().int().min(1).max(10).default(3),
    workspace: z.enum(["worktree", "project-default"]).default("worktree"),
    parentsOnly: z.boolean().default(true),
    stages: z.array(stageSchema).min(2),
  })
  .superRefine((def, ctx) => {
    const ids = new Set(def.stages.map((s) => s.id));
    if (ids.size !== def.stages.length) ctx.addIssue({ code: "custom", message: "stage ids must be unique" });
    for (const s of def.stages) {
      if (s.sendBackTo !== undefined && !ids.has(s.sendBackTo)) ctx.addIssue({ code: "custom", message: `${s.id}: sendBackTo names no stage` });
      if ((s.kind === "work" || s.kind === "address") && s.actor !== "implementer" && s.actor !== "reviewer") {
        ctx.addIssue({ code: "custom", message: `${s.id}: a ${s.kind} stage needs an agent actor` });
      }
    }
    const reviews = def.stages.filter((s) => s.kind === "review" && s.enabled);
    const addresses = def.stages.filter((s) => s.kind === "address" && s.enabled);
    if (reviews.length > 1 || addresses.length > 1) ctx.addIssue({ code: "custom", message: "at most one review and one address stage" });
    if (reviews.length !== addresses.length) ctx.addIssue({ code: "custom", message: "a review stage needs an address stage, and the reverse" });
    if (reviews.length === 1 && def.stages.indexOf(addresses[0]) !== def.stages.indexOf(reviews[0]) + 1) {
      ctx.addIssue({ code: "custom", message: "the address stage must come right after the review stage" });
    }
  });

export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type Stage = Lifecycle["stages"][number];

export function parseLifecycle(text: string): Lifecycle {
  const result = lifecycleSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error(`${LIFECYCLE_FILE} is not valid: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`.trim()).join("; ")}`);
  return result.data;
}

export const NEEDS_YOU = "needs-you";

export interface Entry {
  stage: string;
  at: string;
  note: string;
}

export interface Run {
  ref: string;
  repo: string;
  number: number;
  title: string;
  projectId: string | null;
  itemId: string | null;
  stage: string;
  stoppedAt: string | null;
  round: number;
  pr: number | null;
  implementer: string | null;
  reviewer: string | null;
  stageStartedAt: string;
  history: Entry[];
}

export type Event =
  | { type: "done"; note: string; pr?: number; must?: number }
  | { type: "blocked"; note: string }
  | { type: "approve"; note?: string }
  | { type: "send-back"; note: string }
  | { type: "merged" }
  | { type: "resume"; to?: string; note?: string }
  | { type: "stop"; note?: string };

export type Action = { type: "send"; actor: "implementer" | "reviewer"; stage: Stage; note: string } | { type: "wait"; stage: Stage | null; why: string } | { type: "finished" };

export function stage(def: Lifecycle, id: string): Stage | null {
  return def.stages.find((s) => s.id === id) ?? null;
}

export function enabled(def: Lifecycle): Stage[] {
  return def.stages.filter((s) => s.enabled);
}

function after(def: Lifecycle, id: string): Stage | null {
  const list = enabled(def);
  const index = list.findIndex((s) => s.id === id);
  return index < 0 ? null : (list[index + 1] ?? null);
}

function reviewPair(def: Lifecycle): { review: Stage; address: Stage } | null {
  const review = enabled(def).find((s) => s.kind === "review");
  const address = enabled(def).find((s) => s.kind === "address");
  return review === undefined || address === undefined ? null : { review, address };
}

export function boardOptions(def: Lifecycle): string[] {
  return [...def.stages.map((s) => s.name), def.needsYou];
}

export function stageName(def: Lifecycle, id: string): string {
  return id === NEEDS_YOU ? def.needsYou : (stage(def, id)?.name ?? id);
}

export function begin(def: Lifecycle, base: Omit<Run, "stage" | "stoppedAt" | "round" | "stageStartedAt" | "history">, now: string): { run: Run; action: Action } {
  const first = enabled(def)[0];
  const run: Run = { ...base, stage: first.id, stoppedAt: null, round: 0, stageStartedAt: now, history: [{ stage: first.id, at: now, note: "Lifecycle started" }] };
  return { run, action: enter(run, first, "") };
}

function enter(run: Run, s: Stage, note: string): Action {
  if (s.kind === "end") return { type: "finished" };
  if (s.kind === "gate") return { type: "wait", stage: s, why: s.requires === "merged" ? `waits for you to merge pull request #${run.pr ?? "?"}` : `waits for you at ${s.name}` };
  return { type: "send", actor: s.kind === "review" ? "reviewer" : (s.actor as "implementer" | "reviewer"), stage: s, note };
}

function move(run: Run, to: string, now: string, note: string): Run {
  return { ...run, stage: to, stoppedAt: to === NEEDS_YOU ? run.stage : null, stageStartedAt: now, history: [...run.history, { stage: to, at: now, note }] };
}

export function transition(def: Lifecycle, run: Run, event: Event, now: string): { run: Run; action: Action } {
  if (event.type === "stop") throw new Error("Stopping removes the run; it is not a transition");
  if (run.stage === NEEDS_YOU) {
    if (event.type !== "resume") throw new Error(`${run.ref} is waiting for you; resume it first`);
    const to = stage(def, event.to ?? run.stoppedAt ?? "");
    if (to === null || !to.enabled) throw new Error(`There is no stage "${event.to ?? run.stoppedAt}" to resume at`);
    const reset = to.kind === "review" || to.kind === "address" ? { ...run, round: 0 } : run;
    const next = move(reset, to.id, now, event.note ?? "Resumed");
    return { run: next, action: enter(next, to, event.note ?? "") };
  }
  const current = stage(def, run.stage);
  if (current === null) throw new Error(`${run.ref} is at "${run.stage}", which ${LIFECYCLE_FILE} no longer has; resume it at another stage`);
  if (event.type === "resume") throw new Error(`${run.ref} is not waiting for you`);
  if (event.type === "blocked") {
    const next = move(run, NEEDS_YOU, now, `Blocked at ${current.name}: ${event.note}`);
    return { run: next, action: { type: "wait", stage: null, why: `is blocked at ${current.name}: ${event.note}` } };
  }

  if (current.kind === "gate") {
    if (event.type === "send-back") {
      const back = stage(def, current.sendBackTo ?? "") ?? reviewPair(def)?.address ?? null;
      if (back === null) throw new Error(`${current.name} has nowhere to send back to`);
      const next = move(run, back.id, now, `Sent back: ${event.note}`);
      return { run: next, action: enter(next, back, event.note) };
    }
    if (current.requires === "merged" ? event.type !== "merged" : event.type !== "approve") {
      throw new Error(current.requires === "merged" ? `${current.name} ends when you merge the pull request, not by approval` : `${current.name} waits for your approval`);
    }
  } else if (event.type !== "done") {
    throw new Error(`${current.name} is the agent's to finish; approval and send-back are for your gates`);
  }

  if (event.type === "done" && current.requires === "pull-request" && event.pr === undefined && run.pr === null) {
    throw new Error(`${current.name} must name its pull request: --pr <number>`);
  }
  const withPr = event.type === "done" && event.pr !== undefined ? { ...run, pr: event.pr } : run;
  const note = event.type === "done" || event.type === "approve" ? (event.note ?? "") : "";

  if (current.kind === "review") {
    if (event.type !== "done" || event.must === undefined) throw new Error("A review reports how many must findings it left open: --must <number>");
    const pair = reviewPair(def)!;
    const round = withPr.round + 1;
    if (event.must === 0) {
      const to = after(def, pair.address.id);
      if (to === null) throw new Error("Nothing comes after the review");
      const next = move({ ...withPr, round }, to.id, now, `Review round ${round}: no must findings. ${note}`.trim());
      return { run: next, action: enter(next, to, "") };
    }
    if (round >= def.reviewRounds) {
      const next = move({ ...withPr, round }, NEEDS_YOU, now, `Review round ${round} of ${def.reviewRounds} still has ${event.must} must findings. ${note}`.trim());
      return { run: { ...next, stoppedAt: pair.address.id }, action: { type: "wait", stage: null, why: `still has ${event.must} must findings after ${round} review rounds` } };
    }
    const next = move({ ...withPr, round }, pair.address.id, now, `Review round ${round}: ${event.must} must findings. ${note}`.trim());
    return { run: next, action: enter(next, pair.address, `${event.must} must findings`) };
  }

  if (current.kind === "address") {
    const pair = reviewPair(def)!;
    const next = move(withPr, pair.review.id, now, note || "Findings addressed");
    return { run: next, action: enter(next, pair.review, "") };
  }

  const to = after(def, current.id);
  if (to === null) {
    const next = move(withPr, current.id, now, note);
    return { run: next, action: { type: "finished" } };
  }
  const next = move(withPr, to.id, now, note || (event.type === "merged" ? "Merged" : event.type === "approve" ? "Approved" : "Done"));
  return { run: next, action: enter(next, to, event.type === "approve" ? (event.note ?? "") : "") };
}

export interface Rollup {
  __typename?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

export function checks(rollup: Rollup[]): "passing" | "pending" | "failing" {
  let pending = false;
  for (const c of rollup) {
    if (c.__typename === "StatusContext" || (c.state !== undefined && c.status === undefined)) {
      if (c.state === "FAILURE" || c.state === "ERROR") return "failing";
      if (c.state !== "SUCCESS") pending = true;
      continue;
    }
    if (c.status !== "COMPLETED") {
      pending = true;
      continue;
    }
    if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? "")) return "failing";
  }
  return pending ? "pending" : "passing";
}

export function stagePrompt(def: Lifecycle, run: Run, s: Stage, note: string): string {
  const list = enabled(def);
  const position = list.findIndex((x) => x.id === s.id) + 1;
  const lines = [`Lifecycle of ${run.ref}: ${run.title}`, `Stage ${position} of ${list.length}: ${s.name}`, ""];
  if (s.instructions !== "") lines.push(s.instructions, "");
  if (run.pr !== null) lines.push(`Its pull request is #${run.pr}: gh pr view ${run.pr} -R ${run.repo} --comments`);
  if (s.kind === "review") lines.push(`This is review round ${run.round + 1} of at most ${def.reviewRounds}.`);
  if (s.kind === "address") lines.push(`Address the findings of review round ${run.round}${note === "" ? "" : ` (${note})`}.`);
  if (note !== "" && s.kind !== "address") lines.push(`From the maintainer: ${note}`);
  const flags = [s.requires === "pull-request" && run.pr === null ? " --pr <number>" : "", s.kind === "review" ? " --must <open must findings>" : ""].join("");
  lines.push(
    "",
    "When this stage is finished, report it, and the lifecycle hands on the next one:",
    `  bb awa stage done ${run.ref} --summary "<what you did, in a sentence or two>"${flags}`,
    "If you cannot go on without the maintainer, say why instead:",
    `  bb awa stage blocked ${run.ref} --reason "<what you need>"`,
  );
  return lines.join("\n");
}
