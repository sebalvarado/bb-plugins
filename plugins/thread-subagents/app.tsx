import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS as SEGMENT_GROUPS,
  experimental_useAppPanel,
  experimental_useRpcKeyedQuery,
  experimental_useRpcQuery,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { contract, type Card, type Summary } from "./contract";

const DETAIL_POLL_MS = 10_000;
const SUMMARY_POLL_MS = 30_000;
const TAB = { id: "subagents", context: { kind: "thread" }, availability: "fixed" } as const;

function usePoll(refetch: () => Promise<void>, ms: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void refetch(), ms);
    return () => clearInterval(timer);
  }, [refetch, ms, enabled]);
}

function useSummaries(threadIds: readonly string[]) {
  const joined = threadIds.join("\n");
  const keys = useMemo(() => (joined === "" ? [] : joined.split("\n")), [joined]);
  const query = experimental_useRpcKeyedQuery({ contract, method: "summaries", keys });
  usePoll(query.refetch, SUMMARY_POLL_MS, keys.length > 0);
  return query.data;
}

function useDetail(threadId: string) {
  return experimental_useRpcQuery({ contract, method: "detail", input: { threadId } });
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function active(summary: Summary | undefined): summary is Summary {
  return summary !== undefined && summary.running + summary.stalled > 0;
}

function countLabel(summary: Summary): string {
  return [
    summary.running > 0 ? `${summary.running} running` : null,
    summary.stalled > 0 ? `${summary.stalled} stalled` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ago(at: number | null, now: number): string {
  if (at === null) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STATE_STYLE: Record<Card["state"], string> = {
  running: "bg-success-foreground",
  stalled: "bg-attention",
  finished: "bg-muted-foreground",
};

function SubagentsChip({ threadId }: ExperimentalThreadContextSegmentInput) {
  const summary = useSummaries([threadId])?.[threadId];
  const panel = experimental_useAppPanel();
  if (!active(summary)) return null;
  const label = countLabel(summary);
  return (
    <button
      type="button"
      onClick={() => panel.openTab({ tab: TAB })}
      aria-label={`Subagents: ${label}. Opens the Subagents tab.`}
      title="Open the Subagents tab"
      className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="Bot" aria-hidden className="size-3.5 shrink-0" />
      <span className="tabular-nums">{label}</span>
      {summary.stalled > 0 ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" /> : null}
    </button>
  );
}

function RowItem({ thread, data }: ExperimentalThreadRowMetadataProps<Record<string, Summary> | undefined>) {
  const summary = data?.[thread.id];
  if (!active(summary)) return null;
  return (
    <span title={`Subagents: ${countLabel(summary)}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon name="Bot" aria-hidden className="size-3" />
      {summary.running > 0 ? <span className="tabular-nums">{summary.running}</span> : null}
      {summary.stalled > 0 ? <span aria-label="stalled" className="size-1.5 rounded-full bg-attention" /> : null}
    </span>
  );
}

function Message({ label, sentAt, text }: { label: string; sentAt: string | null; text: string }) {
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-2 py-1 text-xs text-muted-foreground">
        {label}
        {sentAt ? ` · ${sentAt}` : ""}
      </summary>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 text-xs">{text}</pre>
    </details>
  );
}

function SubagentCard({ card, now }: { card: Card; now: number }) {
  return (
    <article className="grid gap-2 rounded-lg border border-border p-3">
      <header className="flex items-center gap-2">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATE_STYLE[card.state]}`} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={card.title}>
          {card.title}
        </h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {card.state}
          {card.lastStepAt !== null ? ` · last step ${ago(card.lastStepAt, now)}` : ""}
        </span>
      </header>
      {card.prompt ? <Message label="Initial prompt" sentAt={card.prompt.sentAt} text={card.prompt.text} /> : null}
      {card.followUps.map((message, index) => (
        <Message key={index} label={`Follow-up ${index + 1}`} sentAt={message.sentAt} text={message.text} />
      ))}
      {card.lastSteps.length > 0 ? (
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Last steps</span>
          <ol className="grid gap-0.5 font-mono text-xs">
            {card.lastSteps.map((step, index) => (
              <li key={index} className="truncate" title={step}>
                {step}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {card.report !== null ? (
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Final report</span>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{card.report}</pre>
        </div>
      ) : null}
      {card.source === "delegation" ? (
        <p className="text-xs text-muted-foreground">Only the title and status are known for this provider.</p>
      ) : null}
    </article>
  );
}

function SubagentsTab({ threadId }: ExperimentalThreadTabProps) {
  const { data, error, isLoading, refetch } = useDetail(threadId);
  usePoll(refetch, DETAIL_POLL_MS);
  const now = useNow(DETAIL_POLL_MS);
  if (isLoading) return <p className="p-3 text-sm text-muted-foreground">Loading subagents…</p>;
  if (error && !data) return <p className="p-3 text-sm text-destructive">Could not read subagents: {error.message}</p>;
  if (!data || data.cards.length === 0) return <p className="p-3 text-sm text-muted-foreground">This thread has run no subagents.</p>;
  return (
    <div className="grid gap-3 p-3">
      {data.cards.map((card) => (
        <SubagentCard key={card.id} card={card} now={now} />
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...TAB,
    title: "Subagents",
    icon: "Bot",
    tooltip: "This thread's subagents, their prompts and their progress",
    layout: "flush",
    useVisible: ({ threadId }) => (useDetail(threadId).data?.cards.length ?? 0) > 0,
    component: SubagentsTab,
  });
  app.slots.experimental_threadContextSegment({
    id: "subagents",
    title: "Subagents",
    group: SEGMENT_GROUPS.thread,
    summary: SubagentsChip,
    useVisible: ({ threadId }) => active(useSummaries([threadId])?.[threadId]),
  });
  app.slots.experimental_threadRowMetadata({
    id: "subagents",
    useData: ({ threads }: ExperimentalThreadRowMetadataDataInput) => useSummaries(threads.map((thread) => thread.id)),
    component: RowItem,
  });
});
