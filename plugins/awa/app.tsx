import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Agent, LifecycleView, Outcome, rpcContract } from "./server";
import { NONE, agentTarget, facets, groups, matches, newWorkspace, ref, statusField, type Field, type Filters, type Item, type Project } from "./project";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SEARCH = "search";
const PROJECT_KEY = "github-projects:project";
const viewsKey = (project: string) => `github-projects:views:${project}`;
const stateKey = (project: string) => `github-projects:state:${project}`;
const MAX_BATCH = 10;
const WORKSPACE_KEY = "github-projects:workspace";

type WorkspaceType = "worktree" | "checkout";

function defined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function WorkspaceSelect({ value, onChange }: { value: WorkspaceType; onChange: (value: WorkspaceType) => void }) {
  return (
    <select
      aria-label="Where a new agent works"
      value={value}
      onChange={(e) => onChange(e.target.value as WorkspaceType)}
      className="h-8 rounded-md border border-border bg-transparent px-2 text-xs"
      title="Where an agent that is starting fresh works. Agents that already have a thread keep working where they are."
    >
      <option value="worktree">in a new worktree</option>
      <option value="checkout">in the main checkout</option>
    </select>
  );
}

type Layout = "board" | "table";

interface View {
  name: string;
  filters: Filters;
  layout: Layout;
  groupBy: string | null;
}

const PRESETS: View[] = [
  { name: "Open", filters: { query: "is:open", fields: {} }, layout: "board", groupBy: null },
  { name: "Mine", filters: { query: "is:open assignee:@me", fields: {} }, layout: "board", groupBy: null },
  { name: "With an agent", filters: { query: "has:agent", fields: {} }, layout: "table", groupBy: null },
  { name: "Open, no agent yet", filters: { query: "is:open is:issue no:agent", fields: {} }, layout: "table", groupBy: null },
];

const OPTION_COLORS: Record<string, string> = {
  GRAY: "#8b949e",
  BLUE: "#4493f8",
  GREEN: "#3fb950",
  YELLOW: "#d29922",
  ORANGE: "#db6d28",
  RED: "#f85149",
  PINK: "#db61a2",
  PURPLE: "#a371f7",
};

const AGENT: Record<Agent["status"], { label: string; dot: string }> = {
  active: { label: "Agent working", dot: "bg-[#4493f8] animate-pulse" },
  starting: { label: "Agent starting", dot: "bg-[#4493f8] animate-pulse" },
  pending: { label: "Agent queued", dot: "bg-[#4493f8]" },
  stopping: { label: "Agent stopping", dot: "bg-[#8b949e]" },
  idle: { label: "Agent waiting", dot: "bg-[#3fb950]" },
  error: { label: "Agent failed", dot: "bg-[#f85149]" },
  archived: { label: "Agent archived", dot: "bg-[#8b949e]" },
  missing: { label: "No agent", dot: "bg-transparent" },
};

const itemRef = (item: Item) => (item.repo === null || item.number === null ? null : ref(item.repo, item.number));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ background: OPTION_COLORS[color] ?? OPTION_COLORS.GRAY }} />;
}

function Chip({ children, title, onClick }: { children: ReactNode; title?: string; onClick?: () => void }) {
  const className = "inline-flex max-w-full items-center gap-1 truncate rounded-full border border-border px-2 py-px text-[0.6875rem] leading-4 text-muted-foreground";
  if (onClick === undefined)
    return (
      <span title={title} className={className}>
        {children}
      </span>
    );
  return (
    <button type="button" title={title} onClick={onClick} className={cn(className, "cursor-pointer hover:border-foreground/40 hover:text-foreground")}>
      {children}
    </button>
  );
}

function StateIcon({ item }: { item: Item }) {
  if (item.kind === "draft") return <Icon name="Circle" className="size-3.5 shrink-0 text-muted-foreground" />;
  if (item.kind === "pr") {
    const draft = item.pullRequests[0]?.draft === true;
    const color = item.state === "merged" ? "text-[#a371f7]" : item.state === "closed" ? "text-[#f85149]" : draft ? "text-muted-foreground" : "text-[#3fb950]";
    const name = item.state === "merged" ? "GitMerge" : item.state === "closed" ? "GitPullRequestClosed" : draft ? "GitPullRequestDraft" : "GitPullRequest";
    return <Icon name={name} className={cn("size-3.5 shrink-0", color)} />;
  }
  return item.state === "open" ? (
    <Icon name="Circle" className="size-3.5 shrink-0 text-[#3fb950]" />
  ) : (
    <Icon name="CircleCheck" className="size-3.5 shrink-0 text-[#a371f7]" />
  );
}

function AgentDot({ agents }: { agents: Agent[] | undefined }) {
  const latest = agents?.[0];
  if (latest === undefined) return null;
  return (
    <span title={`${AGENT[latest.status].label}: ${latest.title}`} className="inline-flex items-center">
      <span aria-hidden className={cn("size-2 rounded-full", AGENT[latest.status].dot)} />
      <span className="sr-only">{AGENT[latest.status].label}</span>
    </span>
  );
}

function FacetMenu({ name, values, selected, onChange }: { name: string; values: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const shown = [NONE, ...values].filter((v) => v.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <details ref={ref} className="relative">
      <summary
        className={cn(
          "flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border px-2.5 text-xs [&::-webkit-details-marker]:hidden",
          selected.length > 0 ? "border-foreground/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
        )}
      >
        {name}
        {selected.length > 0 ? <span className="rounded-full bg-foreground px-1.5 text-[0.625rem] text-background">{selected.length}</span> : null}
        <Icon name="ChevronDown" className="size-3" />
      </summary>
      <div className="absolute left-0 z-20 mt-1 w-64 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg">
        {values.length > 8 ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${name.toLowerCase()}`} className="mb-1 h-7 text-xs" /> : null}
        <ul className="max-h-72 overflow-y-auto">
          {shown.map((value) => (
            <li key={value}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-state-hover">
                <Checkbox checked={selected.includes(value)} onCheckedChange={() => toggle(value)} />
                <span className={cn("truncate", value === NONE && "italic text-muted-foreground")}>{value === NONE ? `No ${name.toLowerCase()}` : value}</span>
              </label>
            </li>
          ))}
        </ul>
        {selected.length > 0 ? (
          <button type="button" onClick={() => onChange([])} className="mt-1 w-full cursor-pointer rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-state-hover">
            Clear
          </button>
        ) : null}
      </div>
    </details>
  );
}

function Card({
  item,
  fields,
  agents,
  selected,
  active,
  onSelect,
  onOpen,
}: {
  item: Item;
  fields: Field[];
  agents: Agent[] | undefined;
  selected: boolean;
  active: boolean;
  onSelect: (on: boolean) => void;
  onOpen: () => void;
}) {
  const r = itemRef(item);
  const shown = fields.filter((f) => f.kind === "single_select" && f.name !== "Status" && item.fields[f.name] !== undefined);
  return (
    <li
      className={cn(
        "group rounded-lg border bg-card p-2.5 text-card-foreground transition-colors",
        active ? "border-foreground/50" : "border-border hover:border-foreground/25",
      )}
    >
      <div className="flex items-start gap-2">
        {r === null ? (
          <span className="size-4" />
        ) : (
          <Checkbox checked={selected} onCheckedChange={(on) => onSelect(on === true)} aria-label={`Select ${r}`} className={cn("mt-0.5", !selected && "opacity-40 group-hover:opacity-100")} />
        )}
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 cursor-pointer text-left">
          <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
            <StateIcon item={item} />
            <span className="truncate">{r === null ? "Draft" : `${item.repo!.split("/")[1]}#${item.number}`}</span>
            <span className="ml-auto">
              <AgentDot agents={agents} />
            </span>
          </span>
          <span className="mt-1 line-clamp-3 block text-[0.8125rem] leading-snug">{item.title}</span>
        </button>
      </div>
      {shown.length > 0 || item.labels.length > 0 || item.subIssues !== null ? (
        <div className="mt-2 flex flex-wrap gap-1 pl-6">
          {shown.map((f) => (
            <Chip key={f.name} title={f.name}>
              <Dot color={f.options.find((o) => o.name === item.fields[f.name])?.color ?? "GRAY"} />
              {item.fields[f.name]}
            </Chip>
          ))}
          {item.subIssues !== null ? (
            <Chip title="Sub-issues closed">
              {item.subIssues.completed}/{item.subIssues.total}
            </Chip>
          ) : null}
          {item.labels.slice(0, 3).map((l) => (
            <Chip key={l.name}>{l.name}</Chip>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function LifecycleSection({ item, fields, project }: { item: Item; fields: Field[]; project: Project | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [view, setView] = useState<LifecycleView | null>(null);
  const [note, setNote] = useState("");
  const [resumeAt, setResumeAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const repo = item.repo!;
  const number = item.number!;

  const refresh = useCallback(() => {
    rpc.call("lifecycle", { repo, number }).then(setView, (cause) => setNotice(message(cause)));
  }, [rpc, repo, number]);
  useEffect(() => {
    setView(null);
    setNotice(null);
    refresh();
  }, [refresh]);
  useRealtime("awa-lifecycle", (payload) => {
    if ((payload as { ref?: string } | null)?.ref?.toLowerCase() === ref(repo, number).toLowerCase()) refresh();
  });

  if (view === null) return null;
  if (!view.available) return <p className="text-xs text-muted-foreground">No lifecycle: {view.error}</p>;

  const act = async (action: "start" | "approve" | "send-back" | "resume" | "stop") => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await rpc.call("lifecycleAct", defined({ repo, number, action, note: note.trim() === "" ? undefined : note.trim(), to: action === "resume" && resumeAt !== "" ? resumeAt : undefined, projectId: project?.id }));
      setNote("");
      if (result.warning !== null) setNotice(result.warning);
      refresh();
    } catch (cause) {
      setNotice(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const setup = async () => {
    if (project === null) return;
    setBusy(true);
    try {
      setNotice((await rpc.call("lifecycleSetup", { projectId: project.id })).message);
    } catch (cause) {
      setNotice(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const run = view.run;
  const stages = view.stages.filter((s) => s.enabled);
  const current = run === null ? -1 : stages.findIndex((s) => s.id === (run.stage === "needs-you" ? run.stoppedAt : run.stage));
  const stage = run === null ? undefined : view.stages.find((s) => s.id === run.stage);
  const needsYou = run?.stage === "needs-you";
  const missingField = project !== null && view.field !== null && !fields.some((f) => f.name === view.field);
  const name = (id: string) => (id === "needs-you" ? (view.needsYou ?? id) : (view.stages.find((s) => s.id === id)?.name ?? id));

  return (
    <section className="space-y-2.5 rounded-lg border border-border p-3">
      <h3 className="flex items-center gap-2 text-xs font-medium">
        Lifecycle
        {run !== null && run.round > 0 ? <span className="font-normal text-muted-foreground">review round {run.round} of {view.reviewRounds}</span> : null}
      </h3>
      {missingField ? (
        <p className="text-xs text-muted-foreground">
          This board has no {view.field} field yet.{" "}
          <button type="button" disabled={busy} onClick={setup} className="cursor-pointer underline underline-offset-2 hover:text-foreground">
            Add it
          </button>
        </p>
      ) : null}
      {run === null ? (
        <>
          <p className="text-xs text-muted-foreground">
            Agents take it through {stages.map((s) => s.name.toLowerCase()).join(", ")}. It stops for you at {view.stages.filter((s) => s.kind === "gate" && s.enabled).map((s) => s.name.toLowerCase()).join(" and ")}.
          </p>
          <Button size="sm" className="w-full" disabled={busy} onClick={() => act("start")}>
            <Icon name="Play" className="size-3.5" />
            Start the lifecycle
          </Button>
        </>
      ) : (
        <>
          <ol className="space-y-0.5">
            {stages.map((s, i) => (
              <li key={s.id} className={cn("flex items-center gap-2 text-xs", i > current && "text-muted-foreground")}>
                <span
                  aria-hidden
                  className={cn(
                    "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                    i < current ? "border-[#3fb950] bg-[#3fb950]" : i === current ? (needsYou ? "border-[#f85149] bg-[#f85149]" : s.kind === "gate" ? "border-[#d29922] bg-[#d29922]" : "border-[#4493f8] bg-[#4493f8] animate-pulse") : "border-border",
                  )}
                />
                <span className={cn(i === current && "font-medium")}>{s.name}</span>
                {i === current && needsYou ? <span className="text-[#f85149]">{view.needsYou}</span> : null}
                {i === current && s.kind === "gate" && !needsYou ? <span className="text-[#d29922]">waiting for you</span> : null}
              </li>
            ))}
          </ol>
          {needsYou ? <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs">{run.history.at(-1)?.note}</p> : null}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {run.pr !== null && item.repo !== null ? (
              <a className="underline underline-offset-2" href={`https://github.com/${item.repo}/pull/${run.pr}`} target="_blank" rel="noreferrer">
                Pull request #{run.pr}
              </a>
            ) : null}
            {run.implementer !== null ? (
              <button type="button" className="cursor-pointer underline underline-offset-2" onClick={() => navigate.toThread(run.implementer!, { split: true })}>
                Implementer
              </button>
            ) : null}
            {run.reviewer !== null ? (
              <button type="button" className="cursor-pointer underline underline-offset-2" onClick={() => navigate.toThread(run.reviewer!, { split: true })}>
                Reviewer
              </button>
            ) : null}
          </div>
          {(stage?.kind === "gate" || needsYou) && stage?.kind !== "end" ? (
            <div className="space-y-1.5">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder={needsYou ? "What the agent should know when it resumes" : "What to change, if you send it back"}
                className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {needsYou ? (
                  <>
                    <select aria-label="Resume at" value={resumeAt || run.stoppedAt || ""} onChange={(e) => setResumeAt(e.target.value)} className="h-8 rounded-md border border-border bg-transparent px-2 text-xs">
                      {stages
                        .filter((s) => s.kind !== "end")
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            Resume at {s.name}
                          </option>
                        ))}
                    </select>
                    <Button size="sm" disabled={busy} onClick={() => act("resume")}>
                      Resume
                    </Button>
                  </>
                ) : (
                  <>
                    {stage?.requires === "merged" ? (
                      <span className="text-xs text-muted-foreground">Merge pull request #{run.pr ?? "?"} on GitHub; the lifecycle notices within five minutes.</span>
                    ) : (
                      <Button size="sm" disabled={busy} onClick={() => act("approve")}>
                        <Icon name="Check" className="size-3.5" />
                        Approve {stage?.name.toLowerCase()}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={busy || note.trim() === ""} onClick={() => act("send-back")}>
                      Send back
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : null}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">History</summary>
            <ul className="mt-1 space-y-1">
              {[...run.history].reverse().map((h, i) => (
                <li key={i} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
                  <span className="text-muted-foreground tabular-nums">{new Date(h.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  <span>
                    <span className="font-medium">{name(h.stage)}</span>
                    {h.note === "" ? null : <span className="text-muted-foreground"> · {h.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          {stage?.kind === "end" ? null : (
            <button type="button" disabled={busy} onClick={() => act("stop")} className="cursor-pointer text-xs text-muted-foreground hover:text-destructive">
              Stop the lifecycle
            </button>
          )}
        </>
      )}
      {notice !== null ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
    </section>
  );
}

function Detail({
  item,
  fields,
  project,
  agents,
  busy,
  workspace,
  onWorkspace,
  onClose,
  onContinue,
  onFilter,
}: {
  item: Item;
  fields: Field[];
  project: Project | null;
  agents: Agent[] | undefined;
  busy: boolean;
  workspace: WorkspaceType;
  onWorkspace: (value: WorkspaceType) => void;
  onClose: () => void;
  onContinue: () => void;
  onFilter: (query: string) => void;
}) {
  const navigate = useBbNavigate();
  const r = itemRef(item);
  const hasAgent = agents !== undefined && agents.length > 0;
  const fresh = newWorkspace(item, workspace);
  return (
    <aside className="flex min-h-0 w-full flex-col border-l border-border bg-background md:w-[28rem] md:shrink-0">
      <header className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <StateIcon item={item} />
            {r === null ? "Draft item" : item.url === null ? r : (
              <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                {r}
              </a>
            )}
            <span>·</span>
            <span>{item.state}</span>
          </p>
          <h2 className="mt-1 text-[0.9375rem] font-medium leading-snug">{item.title}</h2>
        </div>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close">
          <Icon name="X" className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-[0.8125rem]">
        {r === null ? null : (
          <section className="space-y-2 rounded-lg border border-border p-3">
            {agents === undefined || agents.length === 0 ? (
              <p className="text-muted-foreground">No agent has worked on this yet.</p>
            ) : (
              <ul className="space-y-1">
                {agents.map((a) => (
                  <li key={a.threadId}>
                    <button type="button" onClick={() => navigate.toThread(a.threadId, { split: true })} className="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-state-hover">
                      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", AGENT[a.status].dot)} />
                      <span className="min-w-0 flex-1 truncate">{a.title || a.threadId}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{AGENT[a.status].label.replace("Agent ", "")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-1.5">
              <Button size="sm" className="flex-1" disabled={busy} onClick={onContinue}>
                <Icon name="Play" className="size-3.5" />
                {hasAgent ? "Continue with its agent" : "Start an agent on it"}
              </Button>
              {hasAgent ? null : <WorkspaceSelect value={workspace} onChange={onWorkspace} />}
            </div>
            {hasAgent ? null : (
              <p className="text-xs text-muted-foreground">
                {fresh.type === "checkout"
                  ? "It shares the main checkout with whatever else works there."
                  : fresh.base === null
                    ? "It gets a worktree of its own on a new branch from the default branch."
                    : `It gets a worktree of its own, started from ${fresh.base}, and pushes to that branch.`}
              </p>
            )}
            {project !== null && statusField(fields) !== undefined ? (
              <p className="text-xs text-muted-foreground">If it is not yet in progress on {project.title}, it moves to In progress.</p>
            ) : null}
          </section>
        )}
        {item.kind === "issue" && item.repo !== null && item.subIssues !== null ? <LifecycleSection item={item} fields={fields} project={project} /> : null}
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {fields
            .filter((f) => item.fields[f.name] !== undefined)
            .map((f) => (
              <div key={f.name} className="contents">
                <dt className="text-muted-foreground">{f.name}</dt>
                <dd className="flex items-center gap-1.5">
                  {f.kind === "single_select" ? <Dot color={f.options.find((o) => o.name === item.fields[f.name])?.color ?? "GRAY"} /> : null}
                  {item.fields[f.name]}
                </dd>
              </div>
            ))}
          {item.assignees.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Assignees</dt>
              <dd>{item.assignees.join(", ")}</dd>
            </>
          ) : null}
          {item.milestone !== null ? (
            <>
              <dt className="text-muted-foreground">Milestone</dt>
              <dd>{item.milestone}</dd>
            </>
          ) : null}
          {item.parent !== null ? (
            <>
              <dt className="text-muted-foreground">Parent</dt>
              <dd>
                <button type="button" className="cursor-pointer text-left hover:underline" onClick={() => onFilter(`parent:#${item.parent!.number}`)} title="Show every item under it">
                  #{item.parent.number} {item.parent.title}
                </button>
              </dd>
            </>
          ) : null}
          {item.subIssues !== null ? (
            <>
              <dt className="text-muted-foreground">Sub-issues</dt>
              <dd>
                <button type="button" className="cursor-pointer hover:underline" onClick={() => onFilter(`parent:#${item.number}`)}>
                  {item.subIssues.completed} of {item.subIssues.total} closed
                </button>
              </dd>
            </>
          ) : null}
        </dl>
        {item.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {item.labels.map((l) => (
              <Chip key={l.name} onClick={() => onFilter(`label:"${l.name}"`)}>
                {l.name}
              </Chip>
            ))}
          </div>
        ) : null}
        {item.pullRequests.length > 0 ? (
          <ul className="space-y-1">
            {item.pullRequests.map((p) => (
              <li key={p.url}>
                <a href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:underline">
                  <Icon name={p.state === "merged" ? "GitMerge" : "GitPullRequest"} className={cn("size-3.5", p.state === "merged" ? "text-[#a371f7]" : p.state === "closed" ? "text-[#f85149]" : "text-[#3fb950]")} />
                  #{p.number}
                  <span className="truncate text-muted-foreground">{p.branch}</span>
                  {p.draft ? <span className="text-xs text-muted-foreground">draft</span> : null}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {item.body.trim() === "" ? null : <div className="whitespace-pre-wrap break-words border-t border-border pt-3 text-[0.8125rem] leading-relaxed text-foreground/90">{item.body}</div>}
      </div>
    </aside>
  );
}

function ProjectsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [viewer, setViewer] = useState("");
  const [source, setSource] = useState<string>(() => localStorage.getItem(PROJECT_KEY) ?? "");
  const [board, setBoard] = useState<{ project: Project | null; fields: Field[]; items: Item[]; fetchedAt: number; truncated: boolean } | null>(null);
  const [agents, setAgents] = useState<Record<string, Agent[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(PRESETS[0]);
  const [saved, setSaved] = useState<View[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("is:open");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceType>(() => (localStorage.getItem(WORKSPACE_KEY) === "checkout" ? "checkout" : "worktree"));
  const chooseWorkspace = (value: WorkspaceType) => {
    setWorkspace(value);
    localStorage.setItem(WORKSPACE_KEY, value);
  };
  const report = useCallback((cause: unknown) => setError(message(cause)), []);

  useEffect(() => {
    rpc.call("projects", {}).then((result) => {
      setProjects(result.projects);
      setViewer(result.viewer);
      setSource((current) => (current === SEARCH || result.projects.some((p) => p.id === current) ? current : (result.projects.find((p) => !p.closed)?.id ?? SEARCH)));
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    if (source === "") return;
    localStorage.setItem(PROJECT_KEY, source);
    setSaved(load<View[]>(viewsKey(source), []));
    setView(load<View>(stateKey(source), PRESETS[0]));
    setSelected(new Set());
    setOpenId(null);
  }, [source]);

  useEffect(() => {
    if (source !== "") localStorage.setItem(stateKey(source), JSON.stringify(view));
  }, [source, view]);

  const refreshAgents = useCallback(
    (items: Item[]) => {
      const targets = items.map(agentTarget).filter((t) => t !== null);
      if (targets.length === 0) return setAgents({});
      rpc.call("agents", { targets: targets.slice(0, 1000) }).then((result) => setAgents(result.agents), report);
    },
    [rpc, report],
  );

  const fetchBoard = useCallback(
    (force: boolean) => {
      if (source === "" || source === SEARCH) return;
      setLoading(true);
      rpc
        .call("project", { id: source, force })
        .then((result) => {
          setBoard(result);
          setError(null);
          refreshAgents(result.items);
        }, report)
        .finally(() => setLoading(false));
    },
    [rpc, source, report, refreshAgents],
  );

  const runSearch = useCallback(() => {
    setLoading(true);
    rpc
      .call("search", { query: searchText })
      .then((result) => {
        setBoard({ project: null, fields: [], items: result.items, fetchedAt: Date.now(), truncated: result.total > result.items.length });
        setError(null);
        refreshAgents(result.items);
      }, report)
      .finally(() => setLoading(false));
  }, [rpc, searchText, report, refreshAgents]);

  useEffect(() => {
    setBoard(null);
    if (source === SEARCH) runSearch();
    else fetchBoard(false);
  }, [source]);

  useRealtime("awa-changed", () => {
    if (board !== null) refreshAgents(board.items);
  });

  const fields = board?.fields ?? [];
  const groupField = useMemo(() => {
    const singles = fields.filter((f) => f.kind === "single_select" || f.kind === "iteration");
    return singles.find((f) => f.name === view.groupBy) ?? statusField(fields) ?? singles[0];
  }, [fields, view.groupBy]);

  const hasAgent = useCallback((item: Item) => {
    const r = itemRef(item);
    return r !== null && (agents[r]?.length ?? 0) > 0;
  }, [agents]);

  const shown = useMemo(() => {
    if (board === null) return [];
    if (source === SEARCH) return board.items.filter((i) => matches(i, { query: "", fields: view.filters.fields }, { viewer, hasAgent }));
    return board.items.filter((i) => matches(i, view.filters, { viewer, hasAgent }));
  }, [board, view.filters, viewer, hasAgent, source]);

  const facetList = useMemo(() => (board === null ? [] : facets(board.items, fields)), [board, fields]);
  const open = board?.items.find((i) => i.id === openId) ?? null;

  const setFilters = (filters: Partial<Filters>) => setView((v) => ({ ...v, filters: { ...v.filters, ...filters } }));
  const setQuery = (query: string) => setFilters({ query });

  const go = async (items: Item[]) => {
    const targets = items.flatMap((i) => (i.repo === null || i.number === null ? [] : [defined({ repo: i.repo, number: i.number, projectId: board?.project?.id, workspace })]));
    if (targets.length === 0) return;
    setBusy(true);
    setOutcomes([]);
    try {
      const { outcomes: result } = await rpc.call("continue", { targets: targets.slice(0, MAX_BATCH) });
      setOutcomes(result);
      setSelected(new Set());
      if (result.some((o) => o.status !== null) && board?.project != null) fetchBoard(true);
      else if (board !== null) refreshAgents(board.items);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };

  const select = (item: Item, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(item.id);
      else next.delete(item.id);
      return next;
    });

  const selectedItems = board?.items.filter((i) => selected.has(i.id)) ?? [];
  const owners = useMemo(() => [...new Set((projects ?? []).map((p) => p.owner))], [projects]);

  const saveView = () => {
    const name = (naming ?? "").trim();
    if (name === "") return setNaming(null);
    const next = [...saved.filter((v) => v.name !== name), { ...view, name }];
    setSaved(next);
    localStorage.setItem(viewsKey(source), JSON.stringify(next));
    setView((v) => ({ ...v, name }));
    setNaming(null);
  };
  const removeView = (name: string) => {
    const next = saved.filter((v) => v.name !== name);
    setSaved(next);
    localStorage.setItem(viewsKey(source), JSON.stringify(next));
  };

  const activeFilters = Object.values(view.filters.fields).some((v) => v.length > 0) || view.filters.query.trim() !== "";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name="Github" className="size-4" />
        <select
          aria-label="Project"
          className="h-8 max-w-[20rem] cursor-pointer truncate rounded-md border border-border bg-transparent px-2 text-sm"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={projects === null}
        >
          {projects === null ? <option value="">Loading projects…</option> : null}
          {owners.map((owner) => (
            <optgroup key={owner} label={owner}>
              {(projects ?? [])
                .filter((p) => p.owner === owner)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} ({p.items}){p.closed ? " · closed" : ""}
                  </option>
                ))}
            </optgroup>
          ))}
          <optgroup label="Across repositories">
            <option value={SEARCH}>Search GitHub issues</option>
          </optgroup>
        </select>
        {board?.project ? (
          <a href={board.project.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title="Open on GitHub">
            <Icon name="ExternalLink" className="size-3.5" />
          </a>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {source !== SEARCH ? (
            <>
              <div role="group" aria-label="Layout" className="flex rounded-md border border-border p-0.5">
                {(["board", "table"] as Layout[]).map((l) => (
                  <button
                    key={l}
                    type="button"
                    aria-pressed={view.layout === l}
                    onClick={() => setView((v) => ({ ...v, layout: l }))}
                    className={cn("flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-xs", view.layout === l ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    <Icon name={l === "board" ? "Columns2" : "Rows2"} className="size-3.5" />
                    {l === "board" ? "Board" : "Table"}
                  </button>
                ))}
              </div>
              {view.layout === "board" && fields.some((f) => f.kind === "single_select") ? (
                <select
                  aria-label="Columns by"
                  className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground"
                  value={groupField?.name ?? ""}
                  onChange={(e) => setView((v) => ({ ...v, groupBy: e.target.value }))}
                >
                  {fields
                    .filter((f) => f.kind === "single_select" || f.kind === "iteration")
                    .map((f) => (
                      <option key={f.name} value={f.name}>
                        Columns by {f.name}
                      </option>
                    ))}
                </select>
              ) : null}
            </>
          ) : null}
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => (source === SEARCH ? runSearch() : fetchBoard(true))}>
            <Icon name="RotateCcw" className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { moved } = await rpc.call("organize", { dryRun: false });
                setNotice(moved.length === 0 ? "Every agent thread is already in its epic's section." : `Moved ${moved.length} agent ${moved.length === 1 ? "thread" : "threads"} into ${[...new Set(moved.map((m) => m.section))].join(", ")}.`);
              } catch (cause) {
                report(cause);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="Rows2" className="size-3.5" />
            Group threads
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {source === SEARCH ? (
          <form
            className="flex min-w-[16rem] flex-1 gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch();
            }}
          >
            <Input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder='GitHub search: is:open label:bug "llave"' className="h-8 text-sm" aria-label="GitHub search" />
            <Button type="submit" size="sm" disabled={loading}>
              Search
            </Button>
          </form>
        ) : (
          <div className="relative min-w-[16rem] flex-1">
            <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={view.filters.query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Filter: text, status:ready, epic:"move money", label:bug, assignee:@me, is:open, no:agent'
              className="h-8 pl-8 text-sm"
              aria-label="Filter"
            />
          </div>
        )}
        {facetList.map((f) => (
          <FacetMenu key={f.name} name={f.name} values={f.values} selected={view.filters.fields[f.name] ?? []} onChange={(next) => setFilters({ fields: { ...view.filters.fields, [f.name]: next } })} />
        ))}
        {activeFilters && source !== SEARCH ? (
          <Button variant="ghost" size="sm" onClick={() => setView((v) => ({ ...v, filters: { query: "", fields: {} } }))}>
            Clear
          </Button>
        ) : null}
      </div>

      {source !== SEARCH ? (
        <nav aria-label="Views" className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-1.5 text-xs">
          {[...PRESETS, ...saved].map((v) => {
            const custom = saved.includes(v);
            const current = view.name === v.name;
            return (
              <span key={`${custom}:${v.name}`} className={cn("group inline-flex items-center rounded-md", current ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground")}>
                <button type="button" onClick={() => setView(v)} className="cursor-pointer px-2 py-1">
                  {v.name}
                </button>
                {custom ? (
                  <button type="button" aria-label={`Delete the view ${v.name}`} onClick={() => removeView(v.name)} className="cursor-pointer pr-1.5 opacity-0 group-hover:opacity-100">
                    <Icon name="X" className="size-3" />
                  </button>
                ) : null}
              </span>
            );
          })}
          {naming === null ? (
            <button type="button" onClick={() => setNaming("")} className="cursor-pointer rounded-md px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground">
              <Icon name="Plus" className="mr-1 inline size-3" />
              Save view
            </button>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                saveView();
              }}
            >
              <Input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} onBlur={saveView} placeholder="View name" className="h-6 w-36 text-xs" />
            </form>
          )}
          <span className="ml-auto tabular-nums text-muted-foreground">
            {board === null ? "" : `${shown.length} of ${board.items.length}${board.truncated ? "+" : ""} items`}
          </span>
        </nav>
      ) : null}
      {notice !== null ? (
        <p className="mx-4 mt-2 flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="X" className="size-3.5" />
          </button>
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="mx-4 mt-2 flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            <Icon name="X" className="size-3.5" />
          </button>
        </p>
      ) : null}

      {selectedItems.length > 0 || outcomes.length > 0 ? (
        <div className="mx-4 mt-2 space-y-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm">
          {selectedItems.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {selectedItems.length} selected{selectedItems.length > MAX_BATCH ? `; the first ${MAX_BATCH} go to agents` : ""}
              </span>
              <Button size="sm" disabled={busy} onClick={() => go(selectedItems)}>
                <Icon name="Play" className="size-3.5" />
                {busy ? "Handing to agents…" : "Continue with agents"}
              </Button>
              <span className="text-xs text-muted-foreground">new agents work</span>
              <WorkspaceSelect value={workspace} onChange={chooseWorkspace} />
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>
          ) : null}
          {outcomes.length > 0 ? (
            <ul className="space-y-0.5 text-xs">
              {outcomes.map((o) => (
                <OutcomeRow key={o.ref} outcome={o} />
              ))}
              <li>
                <button type="button" className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setOutcomes([])}>
                  Dismiss
                </button>
              </li>
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          {board === null ? (
            <p className="m-6 text-sm text-muted-foreground">{projects !== null && projects.length === 0 && source !== SEARCH ? "This GitHub login sees no Projects." : "Loading…"}</p>
          ) : shown.length === 0 ? (
            <p className="m-6 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
          ) : view.layout === "board" && source !== SEARCH ? (
            <div className="flex h-full min-h-0 gap-3 p-4">
              {groups(shown, groupField)
                .filter((g) => g.items.length > 0 || (view.filters.fields[groupField?.name ?? ""] ?? []).length === 0)
                .map((g) => {
                  const color = groupField?.options.find((o) => o.name === g.name)?.color ?? "GRAY";
                  return (
                    <section key={g.name} className="flex min-h-0 w-72 shrink-0 flex-col rounded-lg bg-muted/40">
                      <h3 className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-xs font-medium">
                        <Dot color={color} />
                        {g.name}
                        <span className="text-muted-foreground">{g.items.length}</span>
                        {g.items.some((i) => itemRef(i) !== null) ? (
                          <button
                            type="button"
                            className="ml-auto cursor-pointer text-[0.6875rem] font-normal text-muted-foreground hover:text-foreground"
                            onClick={() => setSelected((s) => new Set([...s, ...g.items.filter((i) => itemRef(i) !== null).map((i) => i.id)]))}
                          >
                            Select all
                          </button>
                        ) : null}
                      </h3>
                      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                        {g.items.map((item) => (
                          <Card
                            key={item.id}
                            item={item}
                            fields={fields}
                            agents={agents[itemRef(item) ?? ""]}
                            selected={selected.has(item.id)}
                            active={openId === item.id}
                            onSelect={(on) => select(item, on)}
                            onOpen={() => setOpenId(item.id)}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })}
            </div>
          ) : (
            <Table items={shown} fields={fields} agents={agents} selected={selected} openId={openId} onSelect={select} onOpen={setOpenId} onSelectAll={(on) => setSelected(on ? new Set(shown.filter((i) => itemRef(i) !== null).map((i) => i.id)) : new Set())} />
          )}
        </main>
        {open !== null ? (
          <Detail
            item={open}
            fields={fields}
            project={board?.project ?? null}
            agents={agents[itemRef(open) ?? ""]}
            busy={busy}
            workspace={workspace}
            onWorkspace={chooseWorkspace}
            onClose={() => setOpenId(null)}
            onContinue={() => go([open])}
            onFilter={(query) => setQuery(query)}
          />
        ) : null}
      </div>
    </div>
  );
}

function OutcomeRow({ outcome }: { outcome: Outcome }) {
  const navigate = useBbNavigate();
  const what = outcome.action === "started" ? "started an agent" : outcome.action === "queued" ? "queued for its agent, which is still working" : "sent to its agent";
  return (
    <li className="flex flex-wrap items-center gap-1.5">
      <Icon name={outcome.ok ? "Check" : "AlertTriangle"} className={cn("size-3.5", outcome.ok ? "text-[#3fb950]" : "text-destructive")} />
      <span className="font-medium">{outcome.ref}</span>
      {outcome.ok ? (
        <span>
          {what}
          {outcome.workspace === null ? "" : ` in ${outcome.workspace}`}
          {outcome.status === null ? "" : `, moved to ${outcome.status}`}
        </span>
      ) : null}
      {outcome.error !== null ? <span className="text-destructive">{outcome.error}</span> : null}
      {outcome.threadId !== null ? (
        <button type="button" className="cursor-pointer underline underline-offset-2" onClick={() => navigate.toThread(outcome.threadId!, { split: true })}>
          Open thread
        </button>
      ) : null}
    </li>
  );
}

function Table({
  items,
  fields,
  agents,
  selected,
  openId,
  onSelect,
  onOpen,
  onSelectAll,
}: {
  items: Item[];
  fields: Field[];
  agents: Record<string, Agent[]>;
  selected: Set<string>;
  openId: string | null;
  onSelect: (item: Item, on: boolean) => void;
  onOpen: (id: string) => void;
  onSelectAll: (on: boolean) => void;
}) {
  const columns = fields.filter((f) => f.kind === "single_select" || f.kind === "iteration");
  const selectable = items.filter((i) => itemRef(i) !== null);
  const all = selectable.length > 0 && selectable.every((i) => selected.has(i.id));
  return (
    <table className="w-full border-collapse text-[0.8125rem]">
      <thead className="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground">
        <tr className="border-b border-border">
          <th className="w-8 px-3 py-2">
            <Checkbox checked={all} onCheckedChange={(on) => onSelectAll(on === true)} aria-label="Select every item shown" />
          </th>
          <th className="px-2 py-2 font-normal">Title</th>
          {columns.map((f) => (
            <th key={f.name} className="whitespace-nowrap px-2 py-2 font-normal">
              {f.name}
            </th>
          ))}
          <th className="px-2 py-2 font-normal">Labels</th>
          <th className="px-2 py-2 font-normal">Agent</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const r = itemRef(item);
          const latest = agents[r ?? ""]?.[0];
          return (
            <tr key={item.id} className={cn("border-b border-border hover:bg-state-hover", openId === item.id && "bg-state-active")}>
              <td className="px-3 py-1.5">{r === null ? null : <Checkbox checked={selected.has(item.id)} onCheckedChange={(on) => onSelect(item, on === true)} aria-label={`Select ${r}`} />}</td>
              <td className="max-w-[32rem] px-2 py-1.5">
                <button type="button" onClick={() => onOpen(item.id)} className="flex w-full cursor-pointer items-center gap-1.5 text-left">
                  <StateIcon item={item} />
                  <span className="shrink-0 text-xs text-muted-foreground">{r === null ? "Draft" : `${item.repo!.split("/")[1]}#${item.number}`}</span>
                  <span className="truncate">{item.title}</span>
                </button>
              </td>
              {columns.map((f) => (
                <td key={f.name} className="whitespace-nowrap px-2 py-1.5">
                  {item.fields[f.name] === undefined ? null : (
                    <span className="inline-flex items-center gap-1.5">
                      <Dot color={f.options.find((o) => o.name === item.fields[f.name])?.color ?? "GRAY"} />
                      {item.fields[f.name]}
                    </span>
                  )}
                </td>
              ))}
              <td className="max-w-[14rem] truncate px-2 py-1.5 text-xs text-muted-foreground">{item.labels.map((l) => l.name).join(", ")}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-xs">
                {latest === undefined ? null : (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className={cn("size-2 rounded-full", AGENT[latest.status].dot)} />
                    {AGENT[latest.status].label.replace("Agent ", "")}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "awa",
    title: "Awa",
    icon: "Columns2",
    path: "awa",
    component: ProjectsPage,
  });
});
