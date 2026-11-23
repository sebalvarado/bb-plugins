import { execFile } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  agentTarget,
  continuePrompt,
  inProgressMove,
  matches,
  newWorkspace,
  streamFromTitle,
  sectionName,
  streamOf,
  threadTitle,
  parseContent,
  parseFields,
  parseItems,
  parseRef,
  ref,
  startPrompt,
  type Field,
  type Item,
  type Project,
} from "./project";
import { createEngine } from "./engine";
import { stageName, type Run } from "./lifecycle";

const projectSchema = z.object({
  id: z.string(),
  owner: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  closed: z.boolean(),
  items: z.number(),
});

const fieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["single_select", "text", "number", "date", "iteration"]),
  options: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
});

const linkedSchema = z.object({ number: z.number(), url: z.string(), state: z.enum(["open", "closed", "merged"]), draft: z.boolean(), branch: z.string() });

const itemSchema = z.object({
  id: z.string(),
  kind: z.enum(["issue", "pr", "draft"]),
  repo: z.string().nullable(),
  number: z.number().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  state: z.enum(["open", "closed", "merged"]),
  body: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  assignees: z.array(z.string()),
  milestone: z.string().nullable(),
  parent: z.object({ repo: z.string(), number: z.number(), title: z.string(), url: z.string() }).nullable(),
  subIssues: z.object({ total: z.number(), completed: z.number() }).nullable(),
  pullRequests: z.array(linkedSchema),
  fields: z.record(z.string(), z.string()),
});

const agentSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  status: z.enum(["active", "error", "idle", "pending", "starting", "stopping", "archived", "missing"]),
  updatedAt: z.number(),
});
export type Agent = z.infer<typeof agentSchema>;

const targetSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  number: z.number().int().positive(),
  projectId: z.string().optional(),
  workspace: z.enum(["worktree", "checkout"]).optional(),
});

const outcomeSchema = z.object({
  ref: z.string(),
  ok: z.boolean(),
  action: z.enum(["continued", "queued", "started"]).nullable(),
  threadId: z.string().nullable(),
  status: z.string().nullable(),
  workspace: z.string().nullable(),
  error: z.string().nullable(),
});
export type Outcome = z.infer<typeof outcomeSchema>;

const runSchema = z.object({
  ref: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  projectId: z.string().nullable(),
  itemId: z.string().nullable(),
  stage: z.string(),
  stoppedAt: z.string().nullable(),
  round: z.number(),
  pr: z.number().nullable(),
  implementer: z.string().nullable(),
  reviewer: z.string().nullable(),
  stageStartedAt: z.string(),
  history: z.array(z.object({ stage: z.string(), at: z.string(), note: z.string() })),
});

const lifecycleSchema = z.object({
  available: z.boolean(),
  error: z.string().nullable(),
  field: z.string().nullable(),
  needsYou: z.string().nullable(),
  reviewRounds: z.number(),
  stages: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(["work", "gate", "review", "address", "end"]), requires: z.enum(["pull-request", "merged"]).nullable(), enabled: z.boolean() })),
  run: runSchema.nullable(),
});
export type LifecycleView = z.infer<typeof lifecycleSchema>;

const actSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  number: z.number().int().positive(),
  action: z.enum(["start", "approve", "send-back", "resume", "stop"]),
  note: z.string().max(4000).optional(),
  to: z.string().optional(),
  projectId: z.string().optional(),
});

export const rpcContract = defineRpcContract({
  lifecycle: { input: z.object({ repo: z.string(), number: z.number().int().positive() }), output: lifecycleSchema },
  lifecycleAct: { input: actSchema, output: z.object({ run: runSchema.nullable(), warning: z.string().nullable() }) },
  lifecycleSetup: { input: z.object({ projectId: z.string().min(1) }), output: z.object({ message: z.string() }) },
  projects: { input: z.object({ force: z.boolean().optional() }), output: z.object({ viewer: z.string(), projects: z.array(projectSchema) }) },
  project: {
    input: z.object({ id: z.string().min(1), force: z.boolean().optional() }),
    output: z.object({ project: projectSchema, fields: z.array(fieldSchema), items: z.array(itemSchema), fetchedAt: z.number(), truncated: z.boolean() }),
  },
  search: { input: z.object({ query: z.string() }), output: z.object({ items: z.array(itemSchema), total: z.number(), query: z.string() }) },
  agents: {
    input: z.object({ targets: z.array(z.object({ ref: z.string(), branches: z.array(z.string()).max(10) })).max(1000) }),
    output: z.object({ agents: z.record(z.string(), z.array(agentSchema)) }),
  },
  organize: {
    input: z.object({ dryRun: z.boolean().default(false) }),
    output: z.object({ moved: z.array(z.object({ threadId: z.string(), ref: z.string(), section: z.string() })), skipped: z.number() }),
  },
  continue: { input: z.object({ targets: z.array(targetSchema).min(1).max(10) }), output: z.object({ outcomes: z.array(outcomeSchema) }) },
});

export const CHANGED = "awa-changed";
const MAX_PAGES = 10;
const PROJECT_TTL_MS = 2 * 60_000;
const LIST_TTL_MS = 5 * 60_000;

const ITEM_FIELDS = `
  number title url state body updatedAt
  repository { nameWithOwner }
  labels(first: 20) { nodes { name color } }
  assignees(first: 10) { nodes { login } }
  milestone { title }`;

const ISSUE_OR_PR = `
  __typename
  ... on Issue {
    ${ITEM_FIELDS}
    parent { number title url repository { nameWithOwner } }
    subIssuesSummary { total completed }
    closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number url state isDraft headRefName } }
  }
  ... on PullRequest { ${ITEM_FIELDS} isDraft headRefName }`;

const CONTENT = `${ISSUE_OR_PR}
  ... on DraftIssue { title body updatedAt }`;

const PROJECT_FIELDS = "id number title url closed itemCount: items { totalCount }";

const PROJECTS_QUERY = `query {
  viewer {
    login
    projectsV2(first: 50) { nodes { ${PROJECT_FIELDS} owner { ... on User { login } ... on Organization { login } } } }
    organizations(first: 50) { nodes { login projectsV2(first: 50) { nodes { ${PROJECT_FIELDS} } } } }
  }
}`;

const ITEMS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on ProjectV2 {
      ${PROJECT_FIELDS}
      owner { ... on User { login } ... on Organization { login } }
      fields(first: 50) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name color } }
          ... on ProjectV2IterationField { configuration { iterations { id title } } }
        }
      }
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id updatedAt
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
            }
          }
          content { ${CONTENT} }
        }
      }
    }
  }
}`;

const SEARCH_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) { issueCount nodes { ${ISSUE_OR_PR} } }
}`;

const ITEM_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ${ISSUE_OR_PR}
      ... on Issue { projectItems(first: 20) { nodes { id project { id } } } }
      ... on PullRequest { projectItems(first: 20) { nodes { id project { id } } } }
    }
  }
}`;

const MOVE_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "develop"]);
const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

function exec(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) resolve(String(stdout));
      else reject(new Error(String(stderr).trim() || error.message));
    });
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function project(node: any, owner: string): Project {
  return {
    id: node.id,
    owner: node.owner?.login ?? owner,
    number: node.number,
    title: node.title,
    url: node.url,
    closed: node.closed === true,
    items: node.itemCount?.totalCount ?? 0,
  };
}

interface Link {
  threadId: string;
  createdAt: string;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultProject: {
      type: "project",
      label: "Default project",
      description: "Where agent threads start for repositories no bb project has checked out.",
    },
    workspace: {
      type: "select",
      label: "New agents work in",
      description: "Where a thread started from the board works. A new worktree keeps agents out of each other's files; for an issue with an open pull request it starts from that pull request's branch.",
      options: ["worktree", "checkout"],
      experimental_optionLabels: { worktree: "A new worktree of their own", checkout: "The project's main checkout" },
      default: "worktree",
    },
    groupThreads: {
      type: "select",
      label: "Group agent threads",
      description: "Where a thread started from the board goes in bb's thread list. By epic files it in a section named after its bb project and the issue's epic, created when missing.",
      options: ["epic", "off"],
      experimental_optionLabels: { epic: "In a section per epic", off: "Wherever bb puts it" },
      default: "epic",
    },
    reviewerProvider: { type: "string", label: "Reviewer provider", description: "The bb provider for lifecycle review threads, such as claude-code or codex. Empty uses bb's default." },
    reviewerModel: { type: "string", label: "Reviewer model", description: "The model for lifecycle review threads; use a stronger one than the implementer's. Empty uses the provider's default." },
    implementerProvider: { type: "string", label: "Implementer provider", description: "The bb provider for lifecycle threads that triage, plan and build. Empty uses bb's default." },
    implementerModel: { type: "string", label: "Implementer model", description: "The model for lifecycle threads that triage, plan and build. Empty uses the provider's default." },
  });

  let ghPath: string | null = null;
  async function gh(args: string[]): Promise<string> {
    if (ghPath === null) {
      for (const candidate of GH_CANDIDATES) {
        try {
          await exec(candidate, ["--version"]);
          ghPath = candidate;
          break;
        } catch {}
      }
      if (ghPath === null) throw new Error("The GitHub CLI is not installed. Install it from https://cli.github.com and run gh auth login.");
    }
    return exec(ghPath, args);
  }

  async function graphql(query: string, variables: Record<string, string | number | null>): Promise<any> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value === null) continue;
      args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    }
    const parsed = JSON.parse(await gh(args));
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0 && parsed.data == null) {
      throw new Error(parsed.errors.map((e: { message: string }) => e.message).join("; "));
    }
    return parsed.data;
  }

  let listCache: { at: number; viewer: string; projects: Project[] } | null = null;
  async function projects(force = false) {
    if (!force && listCache !== null && Date.now() - listCache.at < LIST_TTL_MS) return listCache;
    const data = await graphql(PROJECTS_QUERY, {});
    const viewer: string = data.viewer.login;
    const out: Project[] = data.viewer.projectsV2.nodes.filter(Boolean).map((n: any) => project(n, viewer));
    for (const org of data.viewer.organizations.nodes ?? []) {
      for (const n of org?.projectsV2?.nodes ?? []) if (n) out.push(project(n, org.login));
    }
    const seen = new Set<string>();
    const unique = out.filter((p) => !seen.has(p.id) && seen.add(p.id));
    unique.sort(
      (a, b) =>
        Number(a.closed) - Number(b.closed) ||
        Number(a.owner !== viewer) - Number(b.owner !== viewer) ||
        a.owner.localeCompare(b.owner) ||
        b.number - a.number,
    );
    listCache = { at: Date.now(), viewer, projects: unique };
    return listCache;
  }

  interface Board {
    project: Project;
    fields: Field[];
    items: Item[];
    fetchedAt: number;
    truncated: boolean;
  }
  const boards = new Map<string, Board>();
  const loading = new Map<string, Promise<Board>>();

  async function fetchBoard(id: string): Promise<Board> {
    let after: string | null = null;
    let fields: Field[] = [];
    let info: Project | null = null;
    const items: Item[] = [];
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await graphql(ITEMS_QUERY, { id, after });
      const node = data?.node;
      if (node === null || node === undefined) throw new Error("That project does not exist, or this GitHub login cannot read it.");
      if (info === null) {
        info = project(node, node.owner?.login ?? "");
        fields = parseFields(node.fields?.nodes ?? []);
      }
      items.push(...parseItems(node.items.nodes ?? []));
      if (!node.items.pageInfo.hasNextPage) break;
      after = node.items.pageInfo.endCursor;
      truncated = page === MAX_PAGES - 1;
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { project: info!, fields, items, fetchedAt: Date.now(), truncated };
  }

  async function board(id: string, force = false): Promise<Board> {
    const cached = boards.get(id);
    if (!force && cached !== undefined && Date.now() - cached.fetchedAt < PROJECT_TTL_MS) return cached;
    const pending = loading.get(id);
    if (pending !== undefined) return pending;
    const next = fetchBoard(id).then(
      (b) => {
        boards.set(id, b);
        loading.delete(id);
        return b;
      },
      (error) => {
        loading.delete(id);
        throw error;
      },
    );
    loading.set(id, next);
    return next;
  }

  let repoCache: { at: number; repos: Map<string, { projectId: string; path: string; hostId: string }> } | null = null;
  async function repoProjects(): Promise<Map<string, { projectId: string; path: string; hostId: string }>> {
    if (repoCache !== null && Date.now() - repoCache.at < 60_000) return repoCache.repos;
    const repos = new Map<string, { projectId: string; path: string; hostId: string }>();
    for (const p of await bb.sdk.projects.list()) {
      for (const source of p.sources ?? []) {
        if (source.type !== "local_path") continue;
        const remote = await exec("git", ["-C", source.path, "remote", "get-url", "origin"]).catch(() => "");
        const match = remote.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
        if (match !== null && !repos.has(match[1].toLowerCase())) repos.set(match[1].toLowerCase(), { projectId: p.id, path: source.path, hostId: source.hostId });
      }
    }
    repoCache = { at: Date.now(), repos };
    return repos;
  }

  async function bbProjectFor(repo: string): Promise<{ projectId: string; hostId: string | null }> {
    const found = (await repoProjects()).get(repo.toLowerCase());
    if (found !== undefined) return { projectId: found.projectId, hostId: found.hostId };
    const { defaultProject } = await settings.get();
    if (typeof defaultProject === "string" && defaultProject !== "") {
      const sources = (await bb.sdk.projects.list()).find((p) => p.id === defaultProject)?.sources ?? [];
      const source = sources.find((s) => s.isDefault) ?? sources[0];
      return { projectId: defaultProject, hostId: source?.hostId ?? null };
    }
    throw new Error(`No bb project has ${repo} checked out. Add one, or choose a Default project in this plugin's settings.`);
  }

  const linkKey = (r: string) => `link:${r.toLowerCase()}`;

  async function ownLinks(r: string): Promise<Link[]> {
    return (await bb.storage.kv.get<Link[]>(linkKey(r))) ?? [];
  }

  async function builtinLinks(): Promise<Map<string, Link[]>> {
    const out = new Map<string, Link[]>();
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "github",
        method: "listLinks",
        input: null,
        outputSchema: z.object({ links: z.record(z.string(), z.array(z.object({ repo: z.string(), number: z.number(), threadId: z.string(), createdAt: z.string() }).passthrough())) }),
      });
      for (const links of Object.values(result.links)) {
        for (const l of links) {
          const key = ref(l.repo, l.number).toLowerCase();
          out.set(key, [...(out.get(key) ?? []), { threadId: l.threadId, createdAt: l.createdAt }]);
        }
      }
    } catch {}
    return out;
  }

  async function agent(threadId: string): Promise<Agent> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread === null || thread === undefined || thread.deletedAt !== null) return { threadId, title: "", status: "missing", updatedAt: 0 };
      return {
        threadId,
        title: thread.title ?? thread.titleFallback ?? "",
        status: thread.archivedAt !== null ? "archived" : thread.status,
        updatedAt: thread.updatedAt,
      };
    } catch {
      return { threadId, title: "", status: "missing", updatedAt: 0 };
    }
  }

  let branchCache: { at: number; threads: Map<string, string[]> } | null = null;
  async function branchThreads(): Promise<Map<string, string[]>> {
    if (branchCache !== null && Date.now() - branchCache.at < 30_000) return branchCache.threads;
    const threads = new Map<string, string[]>();
    for (const p of await bb.sdk.projects.list()) {
      for (const e of await bb.sdk.environments.list({ projectId: p.id })) {
        const branch = e.branchName?.toLowerCase();
        if (branch === undefined || branch === "" || DEFAULT_BRANCHES.has(branch) || e.lifecycle.phase !== "active") continue;
        const list = await bb.sdk.threads.list({ environmentId: e.id, hasParent: false, limit: 10 });
        const ids = [...list].sort((a, b) => b.updatedAt - a.updatedAt).map((t) => t.id);
        threads.set(branch, [...(threads.get(branch) ?? []), ...ids]);
      }
    }
    branchCache = { at: Date.now(), threads };
    return threads;
  }

  async function agents(targets: { ref: string; branches: string[] }[]): Promise<Record<string, Agent[]>> {
    const external = await builtinLinks();
    const byBranch = targets.some((t) => t.branches.length > 0) ? await branchThreads().catch(() => new Map<string, string[]>()) : new Map<string, string[]>();
    const out: Record<string, Agent[]> = {};
    await Promise.all(
      targets.map(async ({ ref: r, branches }) => {
        const links = [...(await ownLinks(r)), ...(external.get(r.toLowerCase()) ?? [])];
        const linked = links.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((l) => l.threadId);
        const onBranch = branches.flatMap((b) => byBranch.get(b.toLowerCase()) ?? []);
        const ids = [...new Set([...linked, ...onBranch])].slice(0, 5);
        const found = (await Promise.all(ids.map(agent))).filter((a) => a.status !== "missing");
        if (found.length > 0) out[r] = found;
      }),
    );
    return out;
  }

  async function lookup(repo: string, number: number): Promise<{ item: Item; projectItems: { id: string; projectId: string }[] }> {
    const [owner, name] = repo.split("/");
    const data = await graphql(ITEM_QUERY, { owner, name, number });
    const node = data?.repository?.issueOrPullRequest;
    const item = parseContent(node, "", {});
    if (item === null) throw new Error(`${ref(repo, number)} is not an issue or pull request this GitHub login can read`);
    const projectItems = (node.projectItems?.nodes ?? []).map((n: any) => ({ id: n.id, projectId: n.project.id }));
    return { item, projectItems };
  }

  async function moveToInProgress(projectId: string, itemId: string): Promise<string | null> {
    const b = await board(projectId);
    const item = b.items.find((i) => i.id === itemId);
    if (item === undefined) return null;
    const move = inProgressMove(b.fields, item);
    if (move === null) return null;
    await graphql(MOVE_MUTATION, { project: projectId, item: itemId, field: move.fieldId, option: move.optionId });
    item.fields[b.fields.find((f) => f.id === move.fieldId)!.name] = move.to;
    return move.to;
  }

  const sectionIds = new Map<string, Promise<string>>();
  async function sectionFor(stream: string | null, projectId: string, create = true): Promise<string | undefined> {
    if (stream === null || (await settings.get()).groupThreads === "off") return undefined;
    const project = (await bb.sdk.projects.list()).find((p) => p.id === projectId)?.name;
    const name = project === undefined ? stream : sectionName(project, stream);
    const key = name.toLowerCase();
    if (!create && !sectionIds.has(key)) return (await bb.sdk.threadSections.list()).find((s) => s.name.toLowerCase() === key)?.id ?? `new:${key}`;
    let pending = sectionIds.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const existing = (await bb.sdk.threadSections.list()).find((s) => s.name.toLowerCase() === key);
        return existing?.id ?? (await bb.sdk.threadSections.create({ name })).id;
      })();
      sectionIds.set(key, pending);
      pending.catch(() => sectionIds.delete(key));
    }
    return pending;
  }

  async function organize(dryRun: boolean): Promise<{ moved: { threadId: string; ref: string; section: string }[]; skipped: number }> {
    const owners = new Map<string, { ref: string; stream: string | null }>();
    for (const key of await bb.storage.kv.list("link:")) {
      const r = key.slice("link:".length);
      const parsed = parseRef(r);
      if (parsed === null) continue;
      const links = (await bb.storage.kv.get<Link[]>(key)) ?? [];
      if (links.length === 0) continue;
      const stream = await lookup(parsed.repo, parsed.number).then(({ item }) => streamOf(item), () => null);
      for (const link of links) owners.set(link.threadId, { ref: r, stream });
    }
    for (const run of await engine.list()) {
      for (const threadId of [run.implementer, run.reviewer]) if (threadId !== null) owners.set(threadId, { ref: run.ref, stream: streamFromTitle(run.title) });
    }
    const moved: { threadId: string; ref: string; section: string }[] = [];
    let skipped = 0;
    for (const [threadId, { ref: r, stream }] of owners) {
      const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
      const sectionId = thread === null || thread.deletedAt !== null ? undefined : await sectionFor(stream, thread.projectId, !dryRun);
      if (thread === null || sectionId === undefined || thread.sectionId === sectionId) {
        skipped += 1;
        continue;
      }
      const long = `${r}: `;
      const title = thread.title?.toLowerCase().startsWith(long) ? `#${r.split("#")[1]} ${thread.title.slice(long.length)}` : undefined;
      if (!dryRun) await bb.sdk.threads.update({ threadId, sectionId: sectionId.startsWith("new:") ? undefined : sectionId, ...(title === undefined ? {} : { title }) });
      const project = (await bb.sdk.projects.list()).find((p) => p.id === thread.projectId)?.name;
      moved.push({ threadId, ref: r, section: project === undefined ? stream! : sectionName(project, stream!) });
    }
    return { moved, skipped };
  }

  async function defaultWorkspace(): Promise<"worktree" | "checkout"> {
    return (await settings.get()).workspace === "checkout" ? "checkout" : "worktree";
  }

  async function spawnFor(item: Item, project: { title: string } | null, type: "worktree" | "checkout"): Promise<{ id: string; workspace: string }> {
    const { projectId, hostId } = await bbProjectFor(item.repo!);
    if (type === "worktree" && hostId === null) throw new Error(`The bb project for ${item.repo} has no checkout on a machine, so there is nowhere to make a worktree`);
    const title = threadTitle(item);
    const sectionId = await sectionFor(streamOf(item), projectId).catch((error) => {
      bb.log.warn(`Could not file ${ref(item.repo!, item.number!)} under its epic: ${message(error)}`);
      return undefined;
    });
    const workspace = newWorkspace(item, type);
    if (workspace.type === "checkout") {
      const thread = await bb.sdk.threads.spawn({ projectId, sectionId, environment: { type: "project-default" }, title, prompt: startPrompt(item, project, workspace) });
      return { id: thread.id, workspace: "the project's main checkout" };
    }
    if (workspace.base !== null) {
      try {
        const thread = await bb.sdk.threads.spawn({
          projectId,
          environment: { type: "host", hostId: hostId!, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: workspace.base } } },
          title,
          sectionId,
          prompt: startPrompt(item, project, workspace),
        });
        return { id: thread.id, workspace: `a new worktree from ${workspace.base}` };
      } catch (error) {
        bb.log.warn(`A worktree from ${workspace.base} failed (${message(error)}); starting from the default branch instead`);
      }
    }
    const fresh = { type: "worktree" as const, base: null };
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "host", hostId: hostId!, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      title,
      sectionId,
      prompt: startPrompt(item, project, fresh),
    });
    return { id: thread.id, workspace: "a new worktree from the default branch" };
  }

  async function continueOne(target: z.infer<typeof targetSchema>): Promise<Outcome> {
    const r = ref(target.repo, target.number);
    const outcome: Outcome = { ref: r, ok: false, action: null, threadId: null, status: null, workspace: null, error: null };
    try {
      const { item: fresh, projectItems } = await lookup(target.repo, target.number);
      const projectItem = projectItems.find((p) => p.projectId === target.projectId) ?? (target.projectId === undefined ? projectItems[0] : undefined);
      const b = projectItem === undefined ? null : await board(projectItem.projectId);
      const item = b?.items.find((i) => i.id === projectItem!.id) ?? fresh;
      const existing = (await agents([agentTarget(item)!]))[r]?.[0];
      if (existing !== undefined) {
        if (existing.status === "archived") await bb.sdk.threads.unarchive({ threadId: existing.threadId });
        const thread = await bb.sdk.threads.get({ threadId: existing.threadId });
        if (thread?.canRestoreEnvironment === true) await bb.sdk.threads.restoreEnvironment({ threadId: existing.threadId });
        const sent = await bb.sdk.threads.send({
          threadId: existing.threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: continuePrompt(item), mentions: [] }],
        });
        outcome.action = sent.delivery === "queued" ? "queued" : "continued";
        outcome.threadId = existing.threadId;
      } else {
        const thread = await spawnFor(item, b?.project ?? null, target.workspace ?? (await defaultWorkspace()));
        await bb.storage.kv.set(linkKey(r), [...(await ownLinks(r)), { threadId: thread.id, createdAt: new Date().toISOString() }]);
        outcome.action = "started";
        outcome.threadId = thread.id;
        outcome.workspace = thread.workspace;
      }
      outcome.ok = true;
      if (projectItem !== undefined) {
        try {
          outcome.status = await moveToInProgress(projectItem.projectId, projectItem.id);
        } catch (error) {
          outcome.error = `The agent has it, but moving it on the board failed: ${message(error)}`;
        }
      }
      bb.log.info(`${outcome.action} ${r} in ${outcome.threadId}${outcome.status === null ? "" : `, moved to ${outcome.status}`}`);
    } catch (error) {
      outcome.error = message(error);
    }
    return outcome;
  }

  async function continueMany(targets: z.infer<typeof targetSchema>[]): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    for (const target of targets) outcomes.push(await continueOne(target));
    bb.realtime.publish(CHANGED, { refs: outcomes.map((o) => o.ref) });
    return outcomes;
  }

  async function search(query: string) {
    let q = query.trim();
    if (!/\b(repo|org|user|owner):/.test(q)) {
      const repos = [...(await repoProjects()).keys()];
      q = `${q} ${repos.map((r) => `repo:${r}`).join(" ")}`.trim();
    }
    if (!/\bis:(issue|pr|pull-request)\b|\btype:(issue|pr)\b/.test(q)) q = `${q} is:issue`;
    const data = await graphql(SEARCH_QUERY, { q });
    const items = (data.search.nodes ?? [])
      .map((n: any) => parseContent(n, "", {}))
      .filter((i: Item | null): i is Item => i !== null)
      .map((i: Item) => ({ ...i, id: `search:${i.repo}#${i.number}` }));
    return { items, total: data.search.issueCount ?? items.length, query: q };
  }

  const engine = createEngine({
    bb,
    gh,
    graphql,
    fields: async (projectId) => (await board(projectId)).fields,
    forget: (projectId) => boards.delete(projectId),
    lookup,
    checkout: async (repo) => (await repoProjects()).get(repo.toLowerCase()) ?? null,
    agentFor: async (target) => (await agents([target]))[target.ref]?.[0]?.threadId ?? null,
    moveToInProgress,
    section: (stream, projectId) => sectionFor(stream, projectId),
    models: async () => {
      const s = await settings.get();
      const pick = (providerId: unknown, model: unknown) => ({
        ...(typeof providerId === "string" && providerId.trim() !== "" ? { providerId: providerId.trim() } : {}),
        ...(typeof model === "string" && model.trim() !== "" ? { model: model.trim() } : {}),
      });
      return { reviewer: pick(s.reviewerProvider, s.reviewerModel), implementer: pick(s.implementerProvider, s.implementerModel) };
    },
  });

  bb.background.schedule("lifecycle-merges", "*/5 * * * *", () => engine.sweep());

  async function lifecycleView(repo: string, number: number) {
    const { def, error } = await engine.describe(repo);
    const run = await engine.load(ref(repo, number));
    if (def === null) return { available: false, error, field: null, needsYou: null, reviewRounds: 0, stages: [], run };
    return {
      available: true,
      error: null,
      field: def.field,
      needsYou: def.needsYou,
      reviewRounds: def.reviewRounds,
      stages: def.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind, requires: s.requires ?? null, enabled: s.enabled })),
      run,
    };
  }

  async function lifecycleAct(input: z.infer<typeof actSchema>, threadId?: string) {
    const r = ref(input.repo, input.number);
    if (input.action === "start") return engine.start(input.repo, input.number, input.projectId);
    if (input.action === "approve") return engine.act(r, { type: "approve", note: input.note }, threadId);
    if (input.action === "send-back") {
      if (input.note === undefined || input.note.trim() === "") throw new Error("Say what to change when sending it back");
      return engine.act(r, { type: "send-back", note: input.note }, threadId);
    }
    if (input.action === "resume") return engine.act(r, { type: "resume", to: input.to, note: input.note }, threadId);
    return engine.act(r, { type: "stop", note: input.note }, threadId);
  }

  bb.rpc.register(rpcContract, {
    projects: async ({ force }) => {
      const { viewer, projects: list } = await projects(force === true);
      return { viewer, projects: list };
    },
    project: ({ id, force }) => board(id, force === true),
    search: ({ query }) => search(query),
    agents: async ({ targets }) => ({ agents: await agents(targets) }),
    continue: async ({ targets }) => ({ outcomes: await continueMany(targets) }),
    organize: async ({ dryRun }) => organize(dryRun),
    lifecycle: ({ repo, number }) => lifecycleView(repo, number),
    lifecycleAct: (input) => lifecycleAct(input),
    lifecycleSetup: async ({ projectId }) => {
      const b = await board(projectId);
      const repo = b.items.find((i) => i.repo !== null)?.repo ?? undefined;
      if (repo === undefined) throw new Error("The project has no issues, so there is no repository to read the lifecycle from");
      const { def } = await engine.definition(repo);
      return { message: await engine.setup(projectId, def) };
    },
  });

  const usage = [
    "Usage:",
    "  bb awa projects [--json]                         every GitHub Project this login can see",
    '  bb awa items <project> [--filter "<query>"] [--json]  a project\'s items, filtered',
    "  bb awa continue <owner/repo#n>... [--project <project>] [--worktree|--checkout] [--json]",
    "                                                               hand issues to agents: continue the thread that worked",
    "                                                               each one, or start one in a new worktree (--checkout:",
    "                                                               the main checkout), and move it to In progress",
    "  bb awa organize [--dry-run] [--json]             file the threads this plugin started in a section per epic",
    "",
    "The lifecycle of a parent issue, defined in the repository's .bb/lifecycle.json:",
    "  bb awa lifecycle setup <project>        add the Stage field to a project's board",
    "  bb awa stage list                       every issue in the lifecycle and its stage",
    "  bb awa stage show <owner/repo#n>        one issue's stage, threads and history",
    "  bb awa stage start <owner/repo#n> [--project <project>]",
    '  bb awa stage done <owner/repo#n> --summary "<text>" [--pr <n>] [--must <n>]   an agent finished its stage',
    '  bb awa stage blocked <owner/repo#n> --reason "<text>"                        an agent needs the maintainer',
    '  bb awa stage approve <owner/repo#n> [--note "<text>"]                       the maintainer passes a gate',
    '  bb awa stage back <owner/repo#n> --note "<what to change>"                  the maintainer sends it back',
    '  bb awa stage resume <owner/repo#n> [--to <stage id>] [--note "<text>"]',
    "  bb awa stage stop <owner/repo#n>",
    "",
    "<project> is a number (owner/number when two owners share it), or part of the title.",
    'A filter is free text plus qualifiers: status:ready epic:"move money" label:bug assignee:@me is:open has:agent no:assignee -label:epic',
  ].join("\n");

  async function resolveProject(text: string): Promise<Project> {
    const { projects: list } = await projects();
    const [owner, number] = text.includes("/") ? text.split("/") : [null, text];
    const byNumber = list.filter((p) => String(p.number) === number && (owner === null || p.owner.toLowerCase() === owner.toLowerCase()));
    if (byNumber.length === 1) return byNumber[0];
    const byTitle = list.filter((p) => p.title.toLowerCase().includes(text.toLowerCase()));
    if (byTitle.length === 1) return byTitle[0];
    const candidates = (byNumber.length > 1 ? byNumber : byTitle).map((p) => `${p.owner}/${p.number} ${p.title}`);
    throw new Error(candidates.length === 0 ? `No project matches "${text}".` : `"${text}" matches several projects: ${candidates.join(", ")}`);
  }

  function option(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  }

  bb.cli.register({
    name: "awa",
    summary: "Run agents from GitHub Projects: hand issues to agents and move epics through their lifecycle",
    commands: [
      { name: "projects", summary: "List every GitHub Project this login can see", usage: "bb awa projects [--json]" },
      { name: "items", summary: "List a project's items, filtered", usage: 'bb awa items <project> [--filter "<query>"] [--json]' },
      { name: "continue", summary: "Continue or start an agent on each issue", usage: "bb awa continue <owner/repo#n>... [--project <project>] [--worktree|--checkout] [--json]" },
      { name: "stage", summary: "Move a parent issue through its lifecycle", usage: "bb awa stage <list|show|start|done|blocked|approve|back|resume|stop> [<owner/repo#n>] [options] [--json]" },
      { name: "organize", summary: "File this plugin's threads in a section per epic", usage: "bb awa organize [--dry-run] [--json]" },
      { name: "lifecycle", summary: "Add the lifecycle's Stage field to a project", usage: "bb awa lifecycle setup <project> [--json]" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const [command, ...rest] = argv.filter((a) => a !== "--json");
      if (command === undefined || command === "help" || argv.includes("--help") || argv.includes("-h")) return { exitCode: 0, stdout: usage };
      try {
        if (command === "lifecycle") {
          if (rest[0] !== "setup" || rest[1] === undefined) return { exitCode: 1, stderr: usage };
          const p = await resolveProject(rest[1]);
          const b = await board(p.id, true);
          const repo = b.items.find((i) => i.repo !== null)?.repo ?? undefined;
          if (repo === undefined) throw new Error("The project has no issues, so there is no repository to read the lifecycle from");
          const text = await engine.setup(p.id, (await engine.definition(repo)).def);
          return { exitCode: 0, stdout: json ? JSON.stringify({ ok: true, message: text }) : `${p.title}: ${text}` };
        }
        if (command === "stage") {
          const [sub, target] = rest;
          if (sub === "list") {
            const runs = await engine.list();
            if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, runs: runs.map(({ history: _h, ...r }) => r) }) };
            if (runs.length === 0) return { exitCode: 0, stdout: "No issue is in the lifecycle." };
            const lines = await Promise.all(
              runs.map(async (r) => {
                const { def } = await engine.describe(r.repo);
                return `${r.ref.padEnd(36)} ${(def === null ? r.stage : stageName(def, r.stage)).padEnd(16)} ${r.title}`;
              }),
            );
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          const parsed = target === undefined ? null : parseRef(target);
          if (sub === undefined || parsed === null) return { exitCode: 1, stderr: usage };
          const r = ref(parsed.repo, parsed.number);
          const number = (flag: string) => {
            const value = option(rest, flag);
            if (value === undefined) return undefined;
            if (!/^\d+$/.test(value)) throw new Error(`${flag} takes a number`);
            return Number(value);
          };
          let result: { run: Run | null; warning: string | null };
          if (sub === "show") {
            const view = await lifecycleView(parsed.repo, parsed.number);
            if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...view }) };
            if (view.run === null) return { exitCode: 0, stdout: view.available ? `${r} is not in the lifecycle.` : `No lifecycle: ${view.error}` };
            const name = (id: string) => (id === "needs-you" ? view.needsYou : view.stages.find((s) => s.id === id)?.name) ?? id;
            const run = view.run;
            const lines = [
              `${r}: ${run.title}`,
              `Stage: ${name(run.stage)}${run.stage === "needs-you" && run.stoppedAt !== null ? ` (stopped at ${name(run.stoppedAt)})` : ""}`,
              `Review rounds: ${run.round} of ${view.reviewRounds}`,
              `Pull request: ${run.pr === null ? "none yet" : `#${run.pr}`}`,
              `Implementer: ${run.implementer ?? "none yet"}   Reviewer: ${run.reviewer ?? "none yet"}`,
              "",
              ...run.history.map((h) => `${h.at.slice(0, 16).replace("T", " ")}  ${name(h.stage)}${h.note === "" ? "" : `: ${h.note}`}`),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          if (sub === "start") {
            const projectName = option(rest, "--project");
            const projectId = projectName === undefined ? undefined : (await resolveProject(projectName)).id;
            result = await engine.start(parsed.repo, parsed.number, projectId);
          } else if (sub === "done") {
            const summary = option(rest, "--summary");
            if (summary === undefined || summary.trim() === "") throw new Error('Say what was done: --summary "<text>"');
            result = await engine.act(r, { type: "done", note: summary, pr: number("--pr"), must: number("--must") }, ctx.threadId);
          } else if (sub === "blocked") {
            const reason = option(rest, "--reason");
            if (reason === undefined || reason.trim() === "") throw new Error('Say what is needed: --reason "<text>"');
            result = await engine.act(r, { type: "blocked", note: reason }, ctx.threadId);
          } else if (sub === "approve" || sub === "back" || sub === "resume" || sub === "stop") {
            const action = sub === "back" ? "send-back" : sub;
            result = await lifecycleAct({ repo: parsed.repo, number: parsed.number, action, note: option(rest, "--note"), to: option(rest, "--to") }, ctx.threadId);
          } else {
            return { exitCode: 1, stderr: usage };
          }
          if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...result }) };
          if (result.run === null) return { exitCode: 0, stdout: `${r} left the lifecycle.` };
          const { def } = await engine.describe(parsed.repo);
          const now = def === null ? result.run.stage : stageName(def, result.run.stage);
          return { exitCode: 0, stdout: `${r} is now at ${now}.${result.warning === null ? "" : `\nWarning: ${result.warning}`}` };
        }
        if (command === "projects") {
          const { projects: list } = await projects(true);
          if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, projects: list }) };
          return { exitCode: 0, stdout: list.map((p) => `${`${p.owner}/${p.number}`.padEnd(28)} ${String(p.items).padStart(4)} items  ${p.title}${p.closed ? "  (closed)" : ""}`).join("\n") };
        }
        if (command === "items") {
          const name = rest[0];
          if (name === undefined || name.startsWith("--")) return { exitCode: 1, stderr: usage };
          const p = await resolveProject(name);
          const b = await board(p.id, true);
          const filter = option(rest, "--filter") ?? "";
          const viewer = (await projects()).viewer;
          const targets = b.items.map(agentTarget).filter((t) => t !== null);
          const withAgents = /\b(has|no):agent\b/.test(filter) ? await agents(targets) : {};
          const shown = b.items.filter((i) =>
            matches(i, { query: filter, fields: {} }, { viewer, hasAgent: (it) => it.repo !== null && it.number !== null && ref(it.repo, it.number) in withAgents }),
          );
          if (json) {
            const rows = shown.slice(0, 300).map(({ body: _body, ...i }) => i);
            return { exitCode: 0, stdout: JSON.stringify({ ok: true, project: b.project, count: shown.length, items: rows }).slice(0, 200_000) };
          }
          const lines = [`${b.project.title}: ${shown.length} of ${b.items.length} items`, ""];
          for (const i of shown.slice(0, 200)) {
            const id = i.repo === null ? "draft" : ref(i.repo, i.number!);
            const tags = Object.entries(i.fields).map(([k, v]) => `${k}=${v}`).join(" ");
            lines.push(`${id.padEnd(36)} ${i.state.padEnd(6)} ${i.title}${tags === "" ? "" : `  [${tags}]`}`);
          }
          if (shown.length > 200) lines.push(`… and ${shown.length - 200} more; narrow the filter`);
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        if (command === "organize") {
          const result = await organize(rest.includes("--dry-run"));
          if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...result }) };
          const verb = rest.includes("--dry-run") ? "would move" : "moved";
          const lines = result.moved.map((m) => `${m.ref}: ${verb} thread ${m.threadId} to ${m.section}`);
          lines.push(`${result.moved.length} ${verb}, ${result.skipped} already in place or with no epic`);
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        if (command === "continue") {
          const projectName = option(rest, "--project");
          const projectId = projectName === undefined ? undefined : (await resolveProject(projectName)).id;
          const refs = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--project");
          const workspace = rest.includes("--checkout") ? ("checkout" as const) : rest.includes("--worktree") ? ("worktree" as const) : undefined;
          const targets = refs.map((text) => {
            const parsed = parseRef(text);
            if (parsed === null) throw new Error(`"${text}" is not owner/repo#number`);
            return { ...parsed, projectId, workspace };
          });
          if (targets.length === 0 || targets.length > 10) return { exitCode: 1, stderr: "Give between 1 and 10 issues, as owner/repo#number." };
          const outcomes = await continueMany(targets);
          const ok = outcomes.every((o) => o.ok);
          if (json) return { exitCode: ok ? 0 : 1, stdout: JSON.stringify({ ok, outcomes }) };
          const lines = outcomes.map((o) =>
            o.ok
              ? `${o.ref}: ${o.action} in thread ${o.threadId}${o.workspace === null ? "" : `, in ${o.workspace}`}${o.status === null ? "" : `, moved to ${o.status}`}${o.error === null ? "" : ` (${o.error})`}`
              : `${o.ref}: failed: ${o.error}`,
          );
          return { exitCode: ok ? 0 : 1, stdout: lines.join("\n") };
        }
        return { exitCode: 1, stderr: usage };
      } catch (error) {
        if (json) return { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { message: message(error) } }) };
        return { exitCode: 1, stderr: message(error) };
      }
    },
  });
}
