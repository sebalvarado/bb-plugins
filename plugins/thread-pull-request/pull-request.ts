export type PullRequest = {
  number: number;
  title: string;
  state: "draft" | "open" | "merged" | "closed";
  url: string;
  baseRefName: string;
  headRefName: string;
  checks: {
    state: "passing" | "failing" | "pending" | "no_checks" | "unknown";
    totalCount: number;
    passedCount: number;
    failedCount: number;
    pendingCount: number;
  };
  review: {
    state: "approved" | "changes_requested" | "review_required" | "review_requested" | "none";
  };
  mergeability: {
    state: "mergeable" | "conflicts" | "blocked" | "draft" | "unknown";
  };
};

export type Tone = "open" | "merged" | "closed" | "draft";

export type Signal = { tone: "failing" | "pending"; label: string };

export type Chip = {
  icon: string;
  tone: Tone;
  stateLabel: string;
  signal: Signal | null;
  details: string[];
};

const STATE = {
  open: { icon: "GitPullRequestArrow", label: "Open" },
  draft: { icon: "GitPullRequestDraft", label: "Draft" },
  merged: { icon: "GitMerge", label: "Merged" },
  closed: { icon: "GitPullRequestClosed", label: "Closed" },
} as const;

const REVIEW: Record<PullRequest["review"]["state"], string | null> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
  review_requested: "Review requested",
  none: null,
};

function checksLine({ checks }: PullRequest): string | null {
  switch (checks.state) {
    case "failing":
      return `Checks: ${checks.failedCount} of ${checks.totalCount} failing`;
    case "pending":
      return `Checks: ${checks.passedCount} of ${checks.totalCount} passed, ${checks.pendingCount} running`;
    case "passing":
      return `Checks: all ${checks.totalCount} passed`;
    case "no_checks":
      return "No checks";
    case "unknown":
      return null;
  }
}

function mergeLine(pr: PullRequest): string | null {
  switch (pr.mergeability.state) {
    case "conflicts":
      return `Conflicts with ${pr.baseRefName}`;
    case "blocked":
      return "Merge blocked";
    case "mergeable":
      return "Ready to merge";
    case "draft":
    case "unknown":
      return null;
  }
}

function signal(pr: PullRequest): Signal | null {
  if (pr.mergeability.state === "conflicts") return { tone: "failing", label: "Has conflicts" };
  if (pr.checks.state === "failing") return { tone: "failing", label: "Checks failing" };
  if (pr.checks.state === "pending") return { tone: "pending", label: "Checks running" };
  return null;
}

export function chip(pr: PullRequest): Chip {
  const { icon, label } = STATE[pr.state];
  const settled = pr.state === "merged" || pr.state === "closed";
  const details = [
    `${label} · ${pr.headRefName} into ${pr.baseRefName}`,
    ...(settled ? [] : [checksLine(pr), REVIEW[pr.review.state], mergeLine(pr)]),
  ].filter((line): line is string => line !== null);
  return { icon, tone: pr.state, stateLabel: label, signal: settled ? null : signal(pr), details };
}
