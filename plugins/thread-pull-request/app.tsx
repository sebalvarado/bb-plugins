import type { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  UrlLink,
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS as SEGMENT_GROUPS,
  experimental_useRpcKeyedQuery,
  type ExperimentalThreadContextSegmentInput,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { chip, type PullRequest, type Signal, type Tone } from "./pull-request";

// A git install builds without devDependencies, so only the app entry, which bb provides, resolves at runtime.
const defineContract = ((contract: unknown) => contract) as typeof defineRpcContract;

const githubPrStatus = defineContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          pullRequest: z.object({
            number: z.number(),
            title: z.string(),
            state: z.enum(["draft", "open", "merged", "closed"]),
            url: z.string(),
            baseRefName: z.string(),
            headRefName: z.string(),
            checks: z.object({
              state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]),
              totalCount: z.number(),
              passedCount: z.number(),
              failedCount: z.number(),
              pendingCount: z.number(),
            }),
            review: z.object({
              state: z.enum(["approved", "changes_requested", "review_required", "review_requested", "none"]),
            }),
            mergeability: z.object({
              state: z.enum(["mergeable", "conflicts", "blocked", "draft", "unknown"]),
            }),
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
  },
});

function usePullRequest({ environment }: ExperimentalThreadContextSegmentInput): PullRequest | null {
  const environmentId = environment?.id;
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatus,
    method: "pullRequests",
    keys: environmentId ? [environmentId] : [],
  });
  const row = environmentId ? data?.[environmentId] : undefined;
  return row?.outcome === "available" ? row.pullRequest : null;
}

const TONE: Record<Tone, string> = {
  open: "text-success-foreground",
  merged: "text-pr-merged",
  closed: "text-destructive",
  draft: "text-muted-foreground",
};

const SIGNAL: Record<Signal["tone"], string> = {
  failing: "bg-destructive",
  pending: "bg-attention",
};

function PullRequestChip(props: ExperimentalThreadContextSegmentInput) {
  const pr = usePullRequest(props);
  if (!pr) return null;
  const view = chip(pr);
  const label = [`Pull request #${pr.number}: ${pr.title}`, view.stateLabel, view.signal?.label]
    .filter(Boolean)
    .join(", ");
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <UrlLink
            href={pr.url}
            aria-label={`${label}. Opens on GitHub.`}
            className="group inline-flex h-6 min-w-0 max-w-[22rem] items-center gap-1.5 rounded-md border border-border px-1.5 text-xs text-muted-foreground no-underline transition-colors duration-150 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name={view.icon} fallback="GitPullRequestArrow" aria-hidden className={cn("size-3.5 shrink-0", TONE[view.tone])} />
            <span className="shrink-0 tabular-nums text-foreground">#{pr.number}</span>
            <span className="min-w-0 truncate">{pr.title}</span>
            {view.signal ? (
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", SIGNAL[view.signal.tone])} />
            ) : null}
            <Icon
              name="ExternalLink"
              aria-hidden
              className="size-3 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </UrlLink>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="grid max-w-[24rem] gap-1 py-2">
          <span className="text-sm leading-snug">
            #{pr.number} {pr.title}
          </span>
          {view.details.map((line) => (
            <span key={line} className="opacity-80">
              {line}
            </span>
          ))}
          <span className="pt-0.5 opacity-60">Click to open on GitHub</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "pull-request",
    title: "Pull request",
    group: SEGMENT_GROUPS.git,
    order: 0,
    summary: PullRequestChip,
    useVisible: (input) => usePullRequest(input) !== null,
  });
});
