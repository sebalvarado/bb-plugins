import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NONE,
  agentTarget,
  continuePrompt,
  facets,
  groups,
  inProgressMove,
  matches,
  newWorkspace,
  parseFields,
  parseItems,
  parseQuery,
  parseRef,
  sectionName,
  startPrompt,
  streamFromTitle,
  streamOf,
  threadTitle,
  type Context,
  type Item,
} from "./project.ts";

const FIELD_NODES = [
  { id: "F_title", name: "Title", dataType: "TITLE" },
  { id: "F_assignees", name: "Assignees", dataType: "ASSIGNEES" },
  {
    id: "F_status",
    name: "Status",
    dataType: "SINGLE_SELECT",
    options: [
      { id: "o_backlog", name: "Backlog", color: "GRAY" },
      { id: "o_ready", name: "Ready", color: "BLUE" },
      { id: "o_progress", name: "In progress", color: "YELLOW" },
      { id: "o_review", name: "In review", color: "PURPLE" },
      { id: "o_done", name: "Done", color: "GREEN" },
    ],
  },
  { id: "F_epic", name: "Epic", dataType: "SINGLE_SELECT", options: [{ id: "o_money", name: "Move money", color: "RED" }] },
  { id: "F_target", name: "Target", dataType: "DATE" },
];

const fields = parseFields(FIELD_NODES);

function node(overrides: Record<string, unknown> = {}, values: Record<string, string> = {}) {
  return {
    id: "PVTI_1",
    updatedAt: "2026-11-01T00:00:00Z",
    fieldValues: {
      nodes: [
        { text: "ignored title", field: { name: "Title" } },
        ...Object.entries(values).map(([name, value]) => (name === "Target" ? { date: value, field: { name } } : { name: value, field: { name } })),
        {},
      ],
    },
    content: {
      __typename: "Issue",
      number: 12,
      title: "Pay by llave",
      url: "https://github.com/example/repo/issues/12",
      state: "OPEN",
      body: "The payer types a llave.",
      updatedAt: "2026-11-02T00:00:00Z",
      repository: { nameWithOwner: "example/repo" },
      labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "epic:move-money", color: "ededed" }] },
      assignees: { nodes: [{ login: "someone" }] },
      milestone: { title: "Launch" },
      parent: { number: 3, title: "Epic: Move money", url: "https://github.com/example/repo/issues/3", repository: { nameWithOwner: "example/repo" } },
      subIssuesSummary: { total: 0, completed: 0 },
      closedByPullRequestsReferences: { nodes: [{ number: 40, url: "https://github.com/example/repo/pull/40", state: "OPEN", isDraft: true, headRefName: "epic-3-move-money" }] },
      ...overrides,
    },
  };
}

function issue(overrides: Record<string, unknown> = {}, values: Record<string, string> = { Status: "Ready", Epic: "Move money" }): Item {
  return parseItems([node(overrides, values)])[0];
}

const ctx = (agents: string[] = []): Context => ({ viewer: "someone", hasAgent: (i) => agents.includes(`${i.repo}#${i.number}`) });

test("fields keep the project's own columns and their option order, not GitHub's built-in ones", () => {
  assert.deepEqual(
    fields.map((f) => [f.name, f.kind]),
    [
      ["Status", "single_select"],
      ["Epic", "single_select"],
      ["Target", "date"],
    ],
  );
  assert.deepEqual(fields[0].options.map((o) => o.name), ["Backlog", "Ready", "In progress", "In review", "Done"]);
});

test("an issue item carries its field values, parent epic and linked pull requests", () => {
  const item = issue({}, { Status: "Ready", Epic: "Move money", Target: "2026-11-30" });
  assert.equal(item.kind, "issue");
  assert.equal(item.repo, "example/repo");
  assert.equal(item.number, 12);
  assert.deepEqual(item.fields, { Status: "Ready", Epic: "Move money", Target: "2026-11-30" });
  assert.equal(item.parent?.number, 3);
  assert.equal(item.subIssues, null);
  assert.deepEqual(item.pullRequests, [{ number: 40, url: "https://github.com/example/repo/pull/40", state: "open", draft: true, branch: "epic-3-move-money" }]);
});

test("drafts and pull requests parse; an item whose content is hidden is skipped", () => {
  const [draft, pr] = parseItems([
    { id: "d", content: { __typename: "DraftIssue", title: "Idea", body: "" } },
    { id: "p", content: { __typename: "PullRequest", number: 9, title: "Fix", url: "u", state: "MERGED", repository: { nameWithOwner: "a/b" }, headRefName: "fix", isDraft: false } },
    { id: "x", content: null },
  ]);
  assert.equal(draft.kind, "draft");
  assert.equal(draft.repo, null);
  assert.equal(pr.kind, "pr");
  assert.equal(pr.state, "merged");
  assert.deepEqual(pr.pullRequests.map((p) => p.branch), ["fix"]);
  assert.equal(parseItems([{ id: "x", content: null }]).length, 0);
});

test("a query splits into free text and qualifiers, with quotes and negation", () => {
  assert.deepEqual(parseQuery('llave epic:"Move money" -label:epic "two words"'), {
    text: ["llave", "two words"],
    qualifiers: [
      { key: "epic", value: "move money", negate: false },
      { key: "label", value: "epic", negate: true },
    ],
  });
});

test("qualifiers match a project field by its slug, labels, assignees and state", () => {
  const item = issue();
  const holds = (query: string, agents: string[] = []) => matches(item, { query, fields: {} }, ctx(agents));
  assert.ok(holds("status:ready"));
  assert.ok(holds('epic:"move money"'));
  assert.ok(holds("epic:move-money"));
  assert.ok(!holds("status:done"));
  assert.ok(holds("label:bug is:open is:issue"));
  assert.ok(holds("assignee:@me"));
  assert.ok(!holds("-label:bug"));
  assert.ok(holds("parent:#3"));
  assert.ok(holds("has:pr has:parent"));
  assert.ok(holds("no:agent"));
  assert.ok(holds("has:agent", ["example/repo#12"]));
  assert.ok(!holds("no:agent", ["example/repo#12"]));
  assert.ok(holds("LLAVE"));
  assert.ok(holds("#12"));
  assert.ok(!holds("pix"));
});

test("facet filters OR within a field and AND across fields, and can ask for an empty value", () => {
  const ready = issue();
  const bare = issue({ number: 13, labels: { nodes: [] } }, {});
  const pick = (f: Record<string, string[]>) => [ready, bare].filter((i) => matches(i, { query: "", fields: f }, ctx())).map((i) => i.number);
  assert.deepEqual(pick({ Status: ["Ready", "Backlog"] }), [12]);
  assert.deepEqual(pick({ Status: [NONE] }), [13]);
  assert.deepEqual(pick({ Status: ["Ready", NONE], Labels: ["bug"] }), [12]);
  assert.deepEqual(pick({ Status: [] }), [12, 13]);
});

test("facets list each select field's options in order, then the labels and assignees in use", () => {
  const names = facets([issue()], fields).map((f) => f.name);
  assert.deepEqual(names, ["Status", "Epic", "Labels", "Assignees"]);
});

test("board columns follow the field's options, with items that have none first", () => {
  const status = fields[0];
  const columns = groups([issue(), issue({ number: 13 }, {})], status);
  assert.deepEqual(columns.map((c) => [c.name, c.items.length]), [
    ["No Status", 1],
    ["Backlog", 0],
    ["Ready", 1],
    ["In progress", 0],
    ["In review", 0],
    ["Done", 0],
  ]);
});

test("picking an issue up moves it forward to In progress, never back", () => {
  const at = (status: string | null) => inProgressMove(fields, issue({}, status === null ? {} : { Status: status }));
  assert.deepEqual(at("Ready"), { fieldId: "F_status", optionId: "o_progress", from: "Ready", to: "In progress" });
  assert.equal(at("Backlog")?.to, "In progress");
  assert.equal(at(null)?.from, null);
  assert.equal(at("In progress"), null);
  assert.equal(at("In review"), null);
  assert.equal(at("Done"), null);
  assert.equal(inProgressMove(parseFields([FIELD_NODES[3]]), issue()), null);
});

test("an issue's agent is looked for on the branches of its open pull requests only", () => {
  assert.deepEqual(agentTarget(issue()), { ref: "example/repo#12", branches: ["epic-3-move-money"] });
  const merged = issue({ closedByPullRequestsReferences: { nodes: [{ number: 41, url: "u", state: "MERGED", isDraft: false, headRefName: "old" }] } });
  assert.deepEqual(agentTarget(merged)?.branches, []);
  assert.equal(agentTarget(parseItems([{ id: "d", content: { __typename: "DraftIssue", title: "x" } }])[0]), null);
});

test("an issue reference reads as owner/repo#n or as its GitHub URL", () => {
  assert.deepEqual(parseRef("example/repo#12"), { repo: "example/repo", number: 12 });
  assert.deepEqual(parseRef("https://github.com/example/repo/issues/12"), { repo: "example/repo", number: 12 });
  assert.deepEqual(parseRef("https://github.com/example/repo/pull/7"), { repo: "example/repo", number: 7 });
  assert.equal(parseRef("example/repo"), null);
  assert.equal(parseRef("repo#12"), null);
});

test("a new agent is told the board position, the parent epic and the work already open", () => {
  const prompt = startPrompt(issue(), { title: "Veinte" });
  assert.match(prompt, /^Work on GitHub issue example\/repo#12: Pay by llave/);
  assert.match(prompt, /gh issue view 12 -R example\/repo --comments/);
  assert.match(prompt, /"Veinte" project board it is at Status: Ready, Epic: Move money/);
  assert.match(prompt, /belongs to example\/repo#3: Epic: Move money/);
  assert.match(prompt, /pull request #40 \(draft\) on branch epic-3-move-money/);
  assert.match(prompt, /The payer types a llave\./);
  assert.throws(() => startPrompt(parseItems([{ id: "d", content: { __typename: "DraftIssue", title: "x" } }])[0], null));
});

test("a new agent gets its own worktree, started from the open pull request's branch when there is one", () => {
  const withPr = newWorkspace(issue(), "worktree");
  assert.deepEqual(withPr, { type: "worktree", base: "epic-3-move-money" });
  assert.match(startPrompt(issue(), null, withPr), /worktree of your own, on a new branch started from epic-3-move-money/);
  assert.match(startPrompt(issue(), null, withPr), /git push origin HEAD:epic-3-move-money/);
  const bare = issue({ closedByPullRequestsReferences: { nodes: [] } });
  assert.deepEqual(newWorkspace(bare, "worktree"), { type: "worktree", base: null });
  assert.match(startPrompt(bare, null, newWorkspace(bare, "worktree")), /new branch from the default branch/);
  assert.deepEqual(newWorkspace(issue(), "checkout"), { type: "checkout" });
  assert.match(startPrompt(issue(), null, { type: "checkout" }), /main checkout, which other agents .* may be using too/);
});

test("a thread is filed under its issue's epic: the board's Epic field, else the parent epic, else itself when it is one", () => {
  assert.equal(streamFromTitle("Epic: Operate the day — Veinte Desk, the integrante's console"), "Operate the day");
  assert.equal(streamFromTitle("epic: Llaves - the directory as a product"), "Llaves");
  assert.equal(streamFromTitle("Pay by llave"), null);
  assert.equal(streamOf(issue()), "Move money");
  const noField = { ...issue(), fields: {} };
  assert.equal(streamOf(noField), "Move money");
  assert.equal(streamOf({ ...noField, parent: null, subIssues: { total: 2, completed: 0 }, title: "Epic: Run the red — Veinte Tower" }), "Run the red");
  assert.equal(streamOf({ ...noField, parent: null, subIssues: null }), null);
  assert.equal(threadTitle(issue()), "#12 Pay by llave");
  assert.equal(sectionName("veinte", "Go live with the BCE"), "veinte · Go live with the BCE");
});

test("a long description is cut so the prompt stays bounded", () => {
  const prompt = startPrompt(issue({ body: "x".repeat(10_000) }), null);
  assert.ok(prompt.length < 6_000);
  assert.match(prompt, /cut; read the rest/);
});

test("a returning agent is told to catch up on the issue and its open pull request first", () => {
  const prompt = continuePrompt(issue());
  assert.match(prompt, /^Continue the work on example\/repo#12/);
  assert.match(prompt, /gh issue view 12 -R example\/repo --comments/);
  assert.match(prompt, /gh pr view 40 -R example\/repo --comments/);
  assert.doesNotMatch(continuePrompt(issue({ closedByPullRequestsReferences: { nodes: [] } })), /gh pr view/);
});
