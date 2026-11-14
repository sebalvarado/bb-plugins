import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  LIFECYCLE_FILE,
  NEEDS_YOU,
  begin,
  boardOptions,
  checks,
  parseLifecycle,
  stage,
  stageName,
  stagePrompt,
  transition,
  type Action,
  type Event,
  type Lifecycle,
  type Rollup,
  type Run,
} from "./lifecycle";
import { agentTarget, ref, streamFromTitle, type Field, type Item } from "./project";

export interface Deps {
  bb: BbPluginApi;
  gh: (args: string[]) => Promise<string>;
  graphql: (query: string, variables: Record<string, string | number | null>) => Promise<any>;
  fields: (projectId: string) => Promise<Field[]>;
  forget: (projectId: string) => void;
  lookup: (repo: string, number: number) => Promise<{ item: Item; projectItems: { id: string; projectId: string }[] }>;
  checkout: (repo: string) => Promise<{ projectId: string; path: string; hostId: string } | null>;
  agentFor: (target: { ref: string; branches: string[] }) => Promise<string | null>;
  moveToInProgress: (projectId: string, itemId: string) => Promise<string | null>;
  section: (stream: string | null, projectId: string) => Promise<string | undefined>;
  models: () => Promise<{ reviewer: { providerId?: string; model?: string }; implementer: { providerId?: string; model?: string } }>;
}

export const RUN_CHANGED = "github-projects-lifecycle";

const SET_OPTION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

const COLORS: Record<string, string> = { work: "BLUE", gate: "YELLOW", review: "PURPLE", address: "ORANGE", end: "GREEN" };

const prSchema = z.object({
  state: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
  statusCheckRollup: z.array(z.record(z.string(), z.unknown())).nullable().default([]),
  commits: z.array(z.object({ committedDate: z.string() })).default([]),
});

const later = (a: string, b: string) => Date.parse(a) >= Date.parse(b);

export function createEngine(deps: Deps) {
  const { bb } = deps;
  const key = (r: string) => `run:${r.toLowerCase()}`;
  const queues = new Map<string, Promise<unknown>>();

  function serial<T>(r: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(r.toLowerCase()) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(r.toLowerCase(), next);
    return next;
  }

  async function definition(repo: string): Promise<{ def: Lifecycle; projectId: string; hostId: string }> {
    const checkout = await deps.checkout(repo);
    if (checkout === null) throw new Error(`No bb project has ${repo} checked out, so there is no ${LIFECYCLE_FILE} to read`);
    const text = await readFile(join(checkout.path, LIFECYCLE_FILE), "utf8").catch(() => null);
    if (text === null) throw new Error(`${repo} has no ${LIFECYCLE_FILE}; the lifecycle is defined there`);
    return { def: parseLifecycle(text), projectId: checkout.projectId, hostId: checkout.hostId };
  }

  const load = async (r: string) => (await bb.storage.kv.get<Run>(key(r))) ?? null;

  async function save(run: Run): Promise<void> {
    await bb.storage.kv.set(key(run.ref), run);
    bb.realtime.publish(RUN_CHANGED, { ref: run.ref });
  }

  async function list(): Promise<Run[]> {
    const keys = await bb.storage.kv.list("run:");
    const runs = await Promise.all(keys.map((k) => bb.storage.kv.get<Run>(k)));
    return runs.filter((r): r is Run => r !== undefined && r !== null);
  }

  async function notify(title: string, body: string, threadId?: string): Promise<void> {
    try {
      await bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "notifications.send",
        input: { title: title.slice(0, 80), body: body.slice(0, 180), ...(threadId === undefined ? {} : { threadId }) },
        outputSchema: z.object({ ok: z.literal(true), channels: z.array(z.string()) }),
      });
    } catch (error) {
      bb.log.warn(`could not notify: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function mirror(def: Lifecycle, run: Run): Promise<string | null> {
    if (run.projectId === null || run.itemId === null) return null;
    const field = (await deps.fields(run.projectId)).find((f) => f.name === def.field && f.kind === "single_select");
    if (field === undefined) return `The project has no ${def.field} field yet; run bb github-projects lifecycle setup on it`;
    const name = stageName(def, run.stage);
    const option = field.options.find((o) => o.name === name);
    if (option === undefined) return `The ${def.field} field has no "${name}" option`;
    await deps.graphql(SET_OPTION, { project: run.projectId, item: run.itemId, field: field.id, option: option.id });
    deps.forget(run.projectId);
    return null;
  }

  async function alive(threadId: string | null): Promise<boolean> {
    if (threadId === null) return false;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread !== null && thread !== undefined && thread.deletedAt === null;
    } catch {
      return false;
    }
  }

  async function wake(threadId: string, text: string): Promise<void> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread?.archivedAt !== null && thread?.archivedAt !== undefined) await bb.sdk.threads.unarchive({ threadId });
    if (thread?.canRestoreEnvironment === true) await bb.sdk.threads.restoreEnvironment({ threadId });
    await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
  }

  async function implementer(def: Lifecycle, run: Run, prompt: string, item: Item | null): Promise<Run> {
    let threadId = (await alive(run.implementer)) ? run.implementer : null;
    if (threadId === null && item !== null) {
      const target = agentTarget(item);
      threadId = target === null ? null : await deps.agentFor(target);
    }
    if (threadId !== null) {
      await wake(threadId, prompt);
      return { ...run, implementer: threadId };
    }
    const { projectId, hostId } = await definition(run.repo);
    const { implementer: model } = await deps.models();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: def.workspace === "worktree" ? { type: "host", hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } } : { type: "project-default" },
      title: `#${run.number} ${run.title}`.slice(0, 120),
      sectionId: await deps.section(streamFromTitle(run.title), projectId).catch(() => undefined),
      prompt,
      ...model,
    });
    return { ...run, implementer: thread.id };
  }

  async function reviewer(run: Run, prompt: string): Promise<Run> {
    if (await alive(run.reviewer)) {
      await wake(run.reviewer!, prompt);
      return run;
    }
    const { projectId } = await definition(run.repo);
    const { reviewer: model } = await deps.models();
    const implementerThread = run.implementer === null ? null : await bb.sdk.threads.get({ threadId: run.implementer }).catch(() => null);
    const environmentId = implementerThread?.environmentId ?? null;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: environmentId === null ? { type: "project-default" } : { type: "reuse", environmentId },
      title: `Review #${run.number} ${run.title}`.slice(0, 120),
      sectionId: await deps.section(streamFromTitle(run.title), projectId).catch(() => undefined),
      prompt,
      ...model,
    });
    return { ...run, reviewer: thread.id };
  }

  async function perform(def: Lifecycle, run: Run, action: Action, item: Item | null): Promise<{ run: Run; warning: string | null }> {
    let warning = await mirror(def, run).catch((error) => `Could not set the board's ${def.field}: ${error instanceof Error ? error.message : String(error)}`);
    if (action.type === "send") {
      const prompt = stagePrompt(def, run, action.stage, action.note);
      try {
        run = action.actor === "reviewer" ? await reviewer(run, prompt) : await implementer(def, run, prompt, item);
      } catch (error) {
        const message = `Could not hand ${action.stage.name} to the ${action.actor}: ${error instanceof Error ? error.message : String(error)}`;
        warning = warning === null ? message : `${warning}. ${message}`;
        bb.log.error(`${run.ref}: ${message}`);
      }
    } else if (action.type === "wait") {
      await notify(`${run.ref} ${action.stage === null ? "needs you" : `is at ${action.stage.name}`}`, `${run.title} ${action.why}`, run.implementer ?? undefined);
    } else {
      await notify(`${run.ref} is finished`, `${run.title} reached ${stageName(def, run.stage)}`, run.implementer ?? undefined);
    }
    await save(run);
    return { run, warning };
  }

  async function pullRequest(repo: string, number: number) {
    const raw = await deps.gh(["pr", "view", String(number), "-R", repo, "--json", "state,isDraft,url,statusCheckRollup,commits"]);
    return prSchema.parse(JSON.parse(raw));
  }

  async function verify(def: Lifecycle, run: Run, event: Event): Promise<void> {
    if (event.type !== "done") return;
    const current = stage(def, run.stage);
    if (current === null) return;
    const pr = event.pr ?? run.pr;
    const needsPr = current.requires === "pull-request" || current.kind === "review" || current.kind === "address";
    if (!needsPr) return;
    if (pr === null || pr === undefined) throw new Error(`${current.name} needs the pull request: --pr <number>`);
    const info = await pullRequest(run.repo, pr);
    if (info.state !== "OPEN") throw new Error(`Pull request #${pr} is ${info.state.toLowerCase()}, not open`);
    if (current.kind === "review") {
      const [reviews, comments] = await Promise.all([
        deps.gh(["api", `repos/${run.repo}/pulls/${pr}/reviews`, "--paginate", "--jq", "[.[].submitted_at]"]),
        deps.gh(["api", `repos/${run.repo}/issues/${pr}/comments`, "--paginate", "--jq", "[.[].created_at]"]),
      ]);
      const times = [...reviews.split("\n"), ...comments.split("\n")].flatMap((line) => (line.trim() === "" ? [] : (JSON.parse(line) as (string | null)[])));
      if (!times.some((t) => t !== null && later(t, run.stageStartedAt))) throw new Error(`Post the review on pull request #${pr} first; nothing was posted there since this stage began`);
      return;
    }
    if (info.isDraft) throw new Error(`Pull request #${pr} is still a draft; mark it ready once its checks pass`);
    const state = checks((info.statusCheckRollup ?? []) as Rollup[]);
    if (state === "failing") throw new Error(`Pull request #${pr} has failing checks; fix them before reporting`);
    if (state === "pending") throw new Error(`Pull request #${pr} still has checks running; report again when they pass`);
    if (current.kind === "address") {
      const last = info.commits.at(-1)?.committedDate;
      if (last === undefined || !later(last, run.stageStartedAt)) throw new Error(`Nothing was pushed to pull request #${pr} since the review; push the fixes first`);
    }
  }

  async function describe(repo: string) {
    try {
      const { def } = await definition(repo);
      return { def, error: null };
    } catch (error) {
      return { def: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function start(repo: string, number: number, projectId?: string) {
    const r = ref(repo, number);
    return serial(r, async () => {
      if ((await load(r)) !== null) throw new Error(`${r} is already in the lifecycle`);
      const { def } = await definition(repo);
      const { item, projectItems } = await deps.lookup(repo, number);
      if (item.kind !== "issue") throw new Error(`${r} is not an issue`);
      if (item.state !== "open") throw new Error(`${r} is closed`);
      if (def.parentsOnly && item.subIssues === null) throw new Error(`${r} has no sub-issues; the lifecycle is for parent issues`);
      const projectItem = projectItems.find((p) => p.projectId === projectId) ?? projectItems[0] ?? null;
      const now = new Date().toISOString();
      const { run, action } = begin(
        def,
        { ref: r, repo, number, title: item.title, projectId: projectItem?.projectId ?? null, itemId: projectItem?.id ?? null, pr: null, implementer: null, reviewer: null },
        now,
      );
      const result = await perform(def, run, action, item);
      if (projectItem !== null) await deps.moveToInProgress(projectItem.projectId, projectItem.id).catch(() => null);
      return result;
    });
  }

  async function act(r: string, event: Event, threadId?: string) {
    return serial(r, async () => {
      const run = await load(r);
      if (run === null) throw new Error(`${r} is not in the lifecycle`);
      const { def } = await definition(run.repo);
      if (event.type === "stop") {
        await bb.storage.kv.delete(key(r));
        bb.realtime.publish(RUN_CHANGED, { ref: r });
        return { run: null, warning: null };
      }
      const own = [run.implementer, run.reviewer].filter((t) => t !== null);
      if ((event.type === "approve" || event.type === "send-back" || event.type === "resume") && threadId !== undefined && own.includes(threadId)) {
        throw new Error("Gates are the maintainer's: the lifecycle's own threads cannot approve, send back or resume");
      }
      if (event.type === "done" || event.type === "blocked") {
        const current = stage(def, run.stage);
        const expected = current?.kind === "review" || current?.actor === "reviewer" ? run.reviewer : run.implementer;
        if (threadId !== undefined && expected !== null && threadId !== expected) {
          throw new Error(`${stageName(def, run.stage)} belongs to thread ${expected}, not this one`);
        }
      }
      await verify(def, run, event);
      const { run: next, action } = transition(def, run, event, new Date().toISOString());
      const item = action.type === "send" ? await deps.lookup(run.repo, run.number).then((l) => l.item, () => null) : null;
      return perform(def, next, action, item);
    });
  }

  async function sweep(): Promise<void> {
    for (const run of await list()) {
      try {
        const { def } = await definition(run.repo);
        if (stage(def, run.stage)?.requires !== "merged" || run.pr === null) continue;
        const info = await pullRequest(run.repo, run.pr);
        if (info.state === "MERGED") await act(run.ref, { type: "merged" });
      } catch (error) {
        bb.log.warn(`lifecycle sweep, ${run.ref}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function setup(projectId: string, def: Lifecycle): Promise<string> {
    const fields = await deps.fields(projectId);
    const existing = fields.find((f) => f.name === def.field);
    const wanted = boardOptions(def);
    if (existing !== undefined) {
      const missing = wanted.filter((name) => !existing.options.some((o) => o.name === name));
      if (missing.length === 0) return `The ${def.field} field is already set up`;
      throw new Error(`The ${def.field} field exists but lacks ${missing.join(", ")}; add those options on GitHub, since rewriting a field's options would clear its values`);
    }
    const options = [
      ...def.stages.map((s) => ({ name: s.name, color: s.enabled ? COLORS[s.kind] : "GRAY", description: s.enabled ? "" : "Not in use yet" })),
      { name: def.needsYou, color: "RED", description: "Stopped until the maintainer answers" },
    ];
    await deps.graphql(createField(options), { project: projectId, name: def.field });
    deps.forget(projectId);
    return `Added the ${def.field} field with ${options.length} options`;
  }

  return { definition, describe, load, list, start, act, sweep, setup, NEEDS_YOU };
}

export function createField(options: { name: string; color: string; description: string }[]): string {
  const list = options.map((o) => `{ name: ${JSON.stringify(o.name)}, color: ${o.color}, description: ${JSON.stringify(o.description)} }`).join(", ");
  return `mutation($project: ID!, $name: String!) {
  createProjectV2Field(input: { projectId: $project, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: [${list}] }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
}`;
}
