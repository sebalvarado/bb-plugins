Awa orchestrates agents from the boards where your team already plans. Find the issues that matter, put agents on them, and take a parent issue from triage to a pull request you merge, stopping only where you decide. Today Awa reads GitHub Projects.

## What you get

- An Awa page with every GitHub Project your GitHub login can see, yours and your organizations'. Show one as a board, in columns by Status or any other select field, or as a table.
- Filters for every field of the project, labels, assignees and repositories, and a search box that takes free text and qualifiers such as `status:ready`, `epic:"move money"`, `assignee:@me`, `no:agent`. Save a set of filters as a view.
- A search across your repositories' issues in GitHub's own search syntax, for issues on no project.
- On each item, whether an agent is working on it, waiting, or failed, with a link to its thread.
- Continue with agent, on one item or on several selected ones. An issue an agent already worked on goes back to that agent's thread, which catches up and carries on. Any other issue gets a new thread in a new worktree of its own, so agents never share files: from the open pull request's branch if there is one, else from the default branch. Choose the main checkout instead next to the button. The thread is told the issue, its place on the board, its parent and any pull request already open. Each one then moves to In progress if it was not there yet.
- Agent threads grouped by stream of work: each thread the plugin starts goes into a section of bb's thread list named after its project and epic, such as "acme · Move money", created when missing. Group threads files earlier ones the same way. Turn on Organize, By environment in the thread list to see each worktree inside its epic.
- A lifecycle for parent issues: agents triage, plan, build, open the pull request, review it for bugs, security, performance, design and the spec, and address the review, with up to three rounds. It stops for you to approve the plan and to merge. A Stage field next to Status shows where each one is. The stages are in the repository's `.bb/lifecycle.json`; start from [`lifecycle.example.json`](https://github.com/sebalvarado/bb-plugins/blob/main/plugins/awa/lifecycle.example.json).

## How it works

It reads GitHub through the GitHub CLI, so `gh auth status` must pass and the login needs the `project` scope (`gh auth refresh -s project`). Threads start in the bb project whose checkout has the issue's repository as its `origin`, or in the Default project setting. It also finds the threads bb's GitHub plugin started from an issue.

## For agents

`bb awa projects`, `bb awa items <project> --filter "<query>"` `bb awa continue <owner/repo#n>...`, and `bb awa stage done|blocked <owner/repo#n>` to report a lifecycle stage. Each takes `--json`.
