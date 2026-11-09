import assert from "node:assert/strict";
import { test } from "node:test";
import { chip, type PullRequest } from "./pull-request.ts";

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: "Add the thing",
    state: "open",
    url: "https://github.com/example/repo/pull/42",
    baseRefName: "main",
    headRefName: "feature",
    checks: { state: "passing", totalCount: 3, passedCount: 3, failedCount: 0, pendingCount: 0 },
    review: { state: "review_required" },
    mergeability: { state: "mergeable" },
    ...overrides,
  };
}

test("an open pull request with green checks has no signal and says it is ready", () => {
  const result = chip(pullRequest());
  assert.equal(result.icon, "GitPullRequestArrow");
  assert.equal(result.signal, null);
  assert.deepEqual(result.details, [
    "Open · feature into main",
    "Checks: all 3 passed",
    "Review required",
    "Ready to merge",
  ]);
});

test("conflicts outrank running checks in the signal", () => {
  const result = chip(
    pullRequest({
      checks: { state: "pending", totalCount: 4, passedCount: 1, failedCount: 0, pendingCount: 3 },
      mergeability: { state: "conflicts" },
    }),
  );
  assert.deepEqual(result.signal, { tone: "failing", label: "Has conflicts" });
  assert.ok(result.details.includes("Checks: 1 of 4 passed, 3 running"));
  assert.ok(result.details.includes("Conflicts with main"));
});

test("failing checks show a failing signal with the count", () => {
  const result = chip(
    pullRequest({ checks: { state: "failing", totalCount: 5, passedCount: 3, failedCount: 2, pendingCount: 0 } }),
  );
  assert.deepEqual(result.signal, { tone: "failing", label: "Checks failing" });
  assert.ok(result.details.includes("Checks: 2 of 5 failing"));
});

test("a merged pull request drops checks, review and merge lines", () => {
  const result = chip(
    pullRequest({
      state: "merged",
      checks: { state: "failing", totalCount: 1, passedCount: 0, failedCount: 1, pendingCount: 0 },
    }),
  );
  assert.equal(result.icon, "GitMerge");
  assert.equal(result.signal, null);
  assert.deepEqual(result.details, ["Merged · feature into main"]);
});

test("unknown checks and no review add no line", () => {
  const result = chip(
    pullRequest({
      state: "draft",
      checks: { state: "unknown", totalCount: 0, passedCount: 0, failedCount: 0, pendingCount: 0 },
      review: { state: "none" },
      mergeability: { state: "draft" },
    }),
  );
  assert.deepEqual(result.details, ["Draft · feature into main"]);
});
