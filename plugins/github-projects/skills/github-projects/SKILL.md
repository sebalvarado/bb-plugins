---
name: github-projects
description: Read GitHub Projects boards and hand their issues to agents with `bb github-projects`. Use when asked what is on a project board, which issues are ready, in progress or unassigned, or to continue or start agents on issues.
---

# GitHub Projects

`bb github-projects` reads the GitHub Projects this machine's `gh` login can see, and hands issues to bb agents.

```sh
bb github-projects projects                                   # owner/number, item count, title
bb github-projects items <project> --filter "<query>"         # a project's items, filtered
bb github-projects continue <owner/repo#n>... --project <project> [--worktree|--checkout]
bb github-projects stage show <owner/repo#n>                  # a parent issue's lifecycle stage, threads and history
```

`<project>` is its number, `owner/number` when two owners use the same number, or part of its title. Every command takes `--json`.

## Filters

Free text matches the title, number, body, labels, assignees and field values. Qualifiers narrow it, and `-` in front negates one:

- any project field by name, lowercased with spaces as dashes: `status:ready`, `epic:"move money"`, `phase:"2 build"`, `size:m`
- `label:bug`, `assignee:@me`, `repo:owner/name`, `milestone:launch`, `parent:#34`
- `is:open`, `is:closed`, `is:issue`, `is:pr`, `is:draft`
- `has:` or `no:` with `agent`, `assignee`, `label`, `pr`, `parent`, or a field name

## Continue

For each issue (at most 10 at a time): if a bb thread already worked on it, that thread gets a message to catch up on the issue and carry on, queued after its current turn if it is still running. Otherwise a new thread starts in the bb project that has the repository checked out, told the issue, its board fields, its parent epic and any pull request already open. It works in a new worktree of its own, started from the open pull request's branch if there is one and from the default branch otherwise, so two agents never edit the same files; `--checkout` puts it in the project's main checkout instead. The thread is titled `#<n> <title>` and filed in bb's thread list under a section named after its bb project and the issue's epic, such as `acme · Move money`; `bb github-projects organize` files the plugin's earlier threads the same way. Then, if the issue is on the project and its Status is before In progress, it moves to In progress.

Starting threads and moving issues on a shared board are visible to everyone. Run `continue` only when the user asked for it.

## Lifecycle

A parent issue can go through the stages in the repository's `.bb/lifecycle.json`: triage, plan, the maintainer's approval of the plan, build, pull request, review, address review, and ready to merge, which ends when the maintainer merges. Each stage's prompt names the command that reports it. A thread working a stage reports only that:

```sh
bb github-projects stage done <owner/repo#n> --summary "<what was done>" [--pr <n>] [--must <open must findings>]
bb github-projects stage blocked <owner/repo#n> --reason "<what is needed>"
```

Approving, sending back, resuming and stopping are the maintainer's, from the GitHub Projects page or `stage approve|back|resume|stop`. An agent never runs them.
