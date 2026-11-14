export type Kind = "issue" | "pr" | "draft";
export type State = "open" | "closed" | "merged";

export interface Option {
  id: string;
  name: string;
  color: string;
}

export interface Field {
  id: string;
  name: string;
  kind: "single_select" | "text" | "number" | "date" | "iteration";
  options: Option[];
}

export interface Linked {
  number: number;
  url: string;
  state: State;
  draft: boolean;
  branch: string;
}

export interface Item {
  id: string;
  kind: Kind;
  repo: string | null;
  number: number | null;
  title: string;
  url: string | null;
  state: State;
  body: string;
  updatedAt: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  milestone: string | null;
  parent: { repo: string; number: number; title: string; url: string } | null;
  subIssues: { total: number; completed: number } | null;
  pullRequests: Linked[];
  fields: Record<string, string>;
}

export interface Project {
  id: string;
  owner: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  items: number;
}

type Json = Record<string, any>;

const FIELD_KINDS: Record<string, Field["kind"]> = {
  SINGLE_SELECT: "single_select",
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  ITERATION: "iteration",
};

export function parseFields(nodes: Json[]): Field[] {
  const out: Field[] = [];
  for (const node of nodes) {
    const kind = FIELD_KINDS[node?.dataType];
    if (kind === undefined || typeof node.name !== "string" || node.name === "Title") continue;
    const options: Option[] =
      kind === "single_select"
        ? (node.options ?? []).map((o: Json) => ({ id: o.id, name: o.name, color: o.color ?? "GRAY" }))
        : kind === "iteration"
          ? (node.configuration?.iterations ?? []).map((i: Json) => ({ id: i.id, name: i.title, color: "GRAY" }))
          : [];
    out.push({ id: node.id, name: node.name, kind, options });
  }
  return out;
}

function state(raw: unknown): State {
  if (raw === "MERGED") return "merged";
  if (raw === "CLOSED") return "closed";
  return "open";
}

function fieldValue(value: Json): [string, string] | null {
  const name = value?.field?.name;
  if (typeof name !== "string" || name === "Title") return null;
  const raw = value.name ?? value.text ?? value.date ?? value.title ?? value.number;
  if (raw === undefined || raw === null) return null;
  return [name, String(raw)];
}

export function parseContent(content: Json | null, id: string, fields: Record<string, string>, updatedAt = ""): Item | null {
  if (content === null || content === undefined) return null;
  const type = content.__typename;
  const base = {
    id,
    title: String(content.title ?? ""),
    body: String(content.body ?? ""),
    updatedAt: String(content.updatedAt ?? updatedAt),
    fields,
  };
  if (type === "DraftIssue") {
    return {
      ...base,
      kind: "draft",
      repo: null,
      number: null,
      url: null,
      state: "open",
      labels: [],
      assignees: [],
      milestone: null,
      parent: null,
      subIssues: null,
      pullRequests: [],
    };
  }
  if (type !== "Issue" && type !== "PullRequest") return null;
  const parent = content.parent;
  const summary = content.subIssuesSummary;
  const prs: Json[] = content.closedByPullRequestsReferences?.nodes ?? [];
  return {
    ...base,
    kind: type === "Issue" ? "issue" : "pr",
    repo: content.repository?.nameWithOwner ?? null,
    number: typeof content.number === "number" ? content.number : null,
    url: content.url ?? null,
    state: state(content.state),
    labels: (content.labels?.nodes ?? []).map((l: Json) => ({ name: l.name, color: l.color ?? "888888" })),
    assignees: (content.assignees?.nodes ?? []).map((a: Json) => a.login),
    milestone: content.milestone?.title ?? null,
    parent:
      parent === null || parent === undefined
        ? null
        : { repo: parent.repository?.nameWithOwner ?? "", number: parent.number, title: parent.title, url: parent.url },
    subIssues: summary && summary.total > 0 ? { total: summary.total, completed: summary.completed } : null,
    pullRequests:
      type === "PullRequest"
        ? [{ number: content.number, url: content.url, state: state(content.state), draft: content.isDraft === true, branch: content.headRefName ?? "" }]
        : prs.map((p) => ({ number: p.number, url: p.url, state: state(p.state), draft: p.isDraft === true, branch: p.headRefName ?? "" })),
  };
}

export function parseItems(nodes: Json[]): Item[] {
  const out: Item[] = [];
  for (const node of nodes) {
    const fields: Record<string, string> = {};
    for (const value of node?.fieldValues?.nodes ?? []) {
      const pair = fieldValue(value);
      if (pair !== null) fields[pair[0]] = pair[1];
    }
    const item = parseContent(node?.content ?? null, String(node?.id ?? ""), fields, node?.updatedAt);
    if (item !== null) out.push(item);
  }
  return out;
}

export const ref = (repo: string, number: number) => `${repo}#${number}`;

export function parseRef(text: string): { repo: string; number: number } | null {
  const match = text.trim().match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/issues\/|\/pull\/)(\d+)$/);
  if (match === null) return null;
  return { repo: match[1], number: Number(match[2]) };
}

export interface Qualifier {
  key: string;
  value: string;
  negate: boolean;
}

export interface Query {
  text: string[];
  qualifiers: Qualifier[];
}

export function parseQuery(input: string): Query {
  const text: string[] = [];
  const qualifiers: Qualifier[] = [];
  const tokens = input.match(/-?[\w-]+:"[^"]*"|-?[\w-]+:\S+|"[^"]*"|\S+/g) ?? [];
  for (const token of tokens) {
    const match = token.match(/^(-?)([\w-]+):(.*)$/);
    if (match === null) {
      text.push(token.replace(/^"|"$/g, "").toLowerCase());
      continue;
    }
    qualifiers.push({ negate: match[1] === "-", key: match[2].toLowerCase(), value: match[3].replace(/^"|"$/g, "").toLowerCase() });
  }
  return { text: text.filter((t) => t !== ""), qualifiers };
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export interface Context {
  viewer: string;
  hasAgent: (item: Item) => boolean;
}

function qualifierHolds(item: Item, q: Qualifier, ctx: Context): boolean {
  const value = q.value === "@me" ? ctx.viewer.toLowerCase() : q.value;
  switch (q.key) {
    case "is":
      if (value === "open" || value === "closed" || value === "merged") return item.state === value;
      if (value === "issue" || value === "pr" || value === "draft") return item.kind === value;
      return false;
    case "label":
      return item.labels.some((l) => l.name.toLowerCase() === value);
    case "assignee":
      return item.assignees.some((a) => a.toLowerCase() === value);
    case "repo":
      return item.repo !== null && (item.repo.toLowerCase() === value || item.repo.toLowerCase().endsWith(`/${value}`));
    case "milestone":
      return (item.milestone ?? "").toLowerCase() === value;
    case "parent":
      return item.parent !== null && (String(item.parent.number) === value.replace(/^#/, "") || item.parent.title.toLowerCase().includes(value));
    case "has":
    case "no": {
      const present =
        value === "agent"
          ? ctx.hasAgent(item)
          : value === "assignee"
            ? item.assignees.length > 0
            : value === "label"
              ? item.labels.length > 0
              : value === "pr"
                ? item.pullRequests.length > 0
                : value === "parent"
                  ? item.parent !== null
                  : Object.entries(item.fields).some(([name]) => slug(name) === value);
      return q.key === "has" ? present : !present;
    }
    default: {
      const field = Object.entries(item.fields).find(([name]) => slug(name) === q.key);
      if (field === undefined) return false;
      return field[1].toLowerCase() === value || slug(field[1]) === slug(value);
    }
  }
}

export interface Filters {
  query: string;
  fields: Record<string, string[]>;
}

export const NONE = "(none)";

export function matches(item: Item, filters: Filters, ctx: Context): boolean {
  for (const [name, values] of Object.entries(filters.fields)) {
    if (values.length === 0) continue;
    const actual = name === "Labels" ? item.labels.map((l) => l.name) : name === "Assignees" ? item.assignees : name === "Repository" ? [item.repo ?? ""] : [item.fields[name] ?? ""];
    const present = actual.filter((a) => a !== "");
    if (!values.some((v) => (v === NONE ? present.length === 0 : present.includes(v)))) return false;
  }
  const query = parseQuery(filters.query);
  for (const q of query.qualifiers) {
    if (qualifierHolds(item, q, ctx) === q.negate) return false;
  }
  if (query.text.length === 0) return true;
  const haystack = [
    item.title,
    item.number === null ? "" : `#${item.number}`,
    item.repo ?? "",
    item.body,
    ...item.labels.map((l) => l.name),
    ...item.assignees,
    ...Object.values(item.fields),
    item.parent?.title ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return query.text.every((t) => haystack.includes(t));
}

export function facets(items: Item[], fields: Field[]): { name: string; values: string[] }[] {
  const out: { name: string; values: string[] }[] = [];
  for (const field of fields) {
    if (field.kind !== "single_select" && field.kind !== "iteration") continue;
    out.push({ name: field.name, values: field.options.map((o) => o.name) });
  }
  const collect = (pick: (item: Item) => string[]) => [...new Set(items.flatMap(pick))].filter((v) => v !== "").sort((a, b) => a.localeCompare(b));
  out.push({ name: "Labels", values: collect((i) => i.labels.map((l) => l.name)) });
  out.push({ name: "Assignees", values: collect((i) => i.assignees) });
  const repos = collect((i) => (i.repo === null ? [] : [i.repo]));
  if (repos.length > 1) out.push({ name: "Repository", values: repos });
  return out;
}

export function groups(items: Item[], field: Field | undefined): { name: string; items: Item[] }[] {
  if (field === undefined) return [{ name: "All items", items }];
  const order = field.options.map((o) => o.name);
  const byName = new Map<string, Item[]>(order.map((name) => [name, []]));
  const none: Item[] = [];
  for (const item of items) {
    const value = item.fields[field.name];
    const bucket = value === undefined ? undefined : byName.get(value);
    if (bucket === undefined) none.push(item);
    else bucket.push(item);
  }
  const out = [...byName.entries()].map(([name, list]) => ({ name, items: list }));
  return none.length > 0 ? [{ name: `No ${field.name}`, items: none }, ...out] : out;
}

export function statusField(fields: Field[]): Field | undefined {
  return fields.find((f) => f.kind === "single_select" && f.name.toLowerCase() === "status");
}

export function inProgressMove(fields: Field[], item: Item): { fieldId: string; optionId: string; from: string | null; to: string } | null {
  const field = statusField(fields);
  if (field === undefined) return null;
  const target = field.options.findIndex((o) => /^in[ -]?progress$|^doing$/i.test(o.name.trim()));
  if (target < 0) return null;
  const current = item.fields[field.name] ?? null;
  const index = current === null ? -1 : field.options.findIndex((o) => o.name === current);
  if (index >= target) return null;
  return { fieldId: field.id, optionId: field.options[target].id, from: current, to: field.options[target].name };
}

const BODY_LIMIT = 4000;

function openPullRequests(item: Item): Linked[] {
  return item.pullRequests.filter((p) => p.state === "open");
}

export function agentTarget(item: Item): { ref: string; branches: string[] } | null {
  if (item.repo === null || item.number === null) return null;
  return { ref: ref(item.repo, item.number), branches: openPullRequests(item).map((p) => p.branch).filter((b) => b !== "") };
}

export function streamFromTitle(title: string): string | null {
  if (!/^epic\s*:/i.test(title)) return null;
  const name = title.replace(/^epic\s*:\s*/i, "").split(/\s+[—–-]\s+/)[0].trim();
  return name === "" ? null : name.slice(0, 60);
}

export function streamOf(item: Item): string | null {
  const field = Object.entries(item.fields).find(([name]) => name.toLowerCase() === "epic")?.[1];
  if (field !== undefined && field.trim() !== "") return field.trim().slice(0, 60);
  if (item.parent !== null) return streamFromTitle(item.parent.title);
  return item.subIssues === null ? null : streamFromTitle(item.title);
}

export function sectionName(project: string, stream: string): string {
  return `${project} · ${stream}`.slice(0, 80);
}

export function threadTitle(item: Item, prefix = ""): string {
  return `${prefix}#${item.number} ${item.title}`.slice(0, 120);
}

export type Workspace = { type: "worktree"; base: string | null } | { type: "checkout" };

export function newWorkspace(item: Item, type: "worktree" | "checkout"): Workspace {
  if (type === "checkout") return { type };
  return { type, base: openPullRequests(item).find((p) => p.branch !== "")?.branch ?? null };
}

function workspaceLines(workspace: Workspace): string[] {
  if (workspace.type === "checkout")
    return ["You are in the project's main checkout, which other agents and the maintainer may be using too. Check `git status` before you change anything, and work on a branch of your own."];
  if (workspace.base === null) return ["You are in a new worktree of your own, on a new branch from the default branch. No other agent works in it."];
  return [
    `You are in a new worktree of your own, on a new branch started from ${workspace.base}. No other agent works in it.`,
    `Your commits belong on the pull request's branch: push them with \`git push origin HEAD:${workspace.base}\`.`,
  ];
}

export function startPrompt(item: Item, project: { title: string } | null, workspace: Workspace = { type: "checkout" }): string {
  if (item.repo === null || item.number === null) throw new Error("A draft item has no issue to work on");
  const what = item.kind === "pr" ? "pull request" : "issue";
  const view = item.kind === "pr" ? `gh pr view ${item.number} -R ${item.repo} --comments` : `gh issue view ${item.number} -R ${item.repo} --comments`;
  const lines = [`Work on GitHub ${what} ${ref(item.repo, item.number)}: ${item.title}`, "", `Read it in full, with its comments, first:`, `  ${view}`];
  const board = Object.entries(item.fields).map(([name, value]) => `${name}: ${value}`);
  if (project !== null && board.length > 0) lines.push("", `On the "${project.title}" project board it is at ${board.join(", ")}.`);
  if (item.parent !== null) {
    lines.push("", `It belongs to ${ref(item.parent.repo, item.parent.number)}: ${item.parent.title}. Read that too for the larger goal:`, `  gh issue view ${item.parent.number} -R ${item.parent.repo}`);
  }
  if (item.subIssues !== null) lines.push("", `It has ${item.subIssues.total} sub-issues, ${item.subIssues.completed} of them closed.`);
  const open = openPullRequests(item);
  if (open.length > 0 && item.kind === "issue") {
    lines.push("", "Work on it has already started. Continue it rather than starting over:");
    for (const p of open) lines.push(`  pull request #${p.number}${p.draft ? " (draft)" : ""} on branch ${p.branch}: ${p.url}`);
  }
  if (item.body.trim() !== "") {
    const body = item.body.length > BODY_LIMIT ? `${item.body.slice(0, BODY_LIMIT)}\n\n[…cut; read the rest with the command above]` : item.body;
    lines.push("", `Its description:`, "", body);
  }
  lines.push(
    "",
    ...workspaceLines(workspace),
    "",
    item.kind === "pr"
      ? "Take this pull request to the next step it needs. Follow this repository's own instructions for branches, commits and reviews."
      : `Take it to the next step. Follow this repository's own instructions for branches, commits and pull requests, and refer to ${ref(item.repo, item.number)} in what you open.`,
  );
  return lines.join("\n");
}

export function continuePrompt(item: Item): string {
  if (item.repo === null || item.number === null) throw new Error("A draft item has no issue to work on");
  const view = item.kind === "pr" ? `gh pr view ${item.number} -R ${item.repo} --comments` : `gh issue view ${item.number} -R ${item.repo} --comments`;
  const lines = [
    `Continue the work on ${ref(item.repo, item.number)}: ${item.title}`,
    "",
    "First catch up on anything that changed since you last worked on it:",
    `  ${view}`,
  ];
  for (const p of openPullRequests(item)) lines.push(`  gh pr view ${p.number} -R ${item.repo} --comments   # its pull request, with checks and review`);
  lines.push(
    "",
    "Then carry it on to the next step. If nothing is left for you to do, say so and say what it waits on, instead of starting something new.",
  );
  return lines.join("\n");
}
