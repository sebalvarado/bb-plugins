# Awa: objectives and the discussion

Status: design approved on 2026-11-23. This spec covers project 1 of the five below; each later project gets its own spec.

## Why

Awa today hands one issue at a time to agents from a kanban board, and takes a parent issue from triage to a pull request you merge. That stops at the merge and starts only when you pick a card. Awa should instead run the whole loop of building a product: you or Awa set an objective, agents discuss it and agree on a spec, build and review it, and after your ✅ watch it in production and walk the product's interactions, which raises the next objectives.

## The whole loop

Every piece of work is an **objective**. Three sources raise objectives, and one loop builds them:

- **You**, on GitHub or from Awa's page.
- **Watch** (project 4): after a merge, follows the rollout and production logs, errors and metrics against the objective's success signals, and raises a concern when something regresses.
- **Polish** (project 5): walks every user interaction in a real browser, critiques it against a quality bar, and proposes polish, a brainstorm, or a new vertical or larger feature.

The build loop discusses an objective, writes a spec, builds it as reviewed pull requests, and ends at your ✅. Watch and Polish only create objectives; they never change code themselves.

| Project | Delivers |
|---|---|
| 1. Objectives and the discussion | This spec: an objective on GitHub, a discussion among roles, a spec pull request you merge, slices handed to the lifecycle one at a time |
| 2. From spec to builds | Slices built in parallel through the existing Build, Pull request and Review stages |
| 3. The ✅ | One page with the objective's evidence (every pull request, review and check) and your sign-off |
| 4. Watch | Production signals after merge; concerns raised with evidence |
| 5. Polish and discovery | Interaction walks and critiques; proposed objectives |

## Your controls

Awa may start work on its own, within a budget, and always stops at your ✅:

- **Agent-hours per week**, default 20. Counts the running time of work Awa starts itself: objectives raised by Watch or Polish, and the time those loops spend looking. Objectives you start are outside it.
- **Agents at once**, default 3. Counts everything Awa runs, yours included.
- **Per objective**: an optional agent-hour cap in the issue's Limits.
- **Pause all**: no new turn or stage starts; running ones finish.
- Merging the spec pull request, answering a dispute, and the ✅ are yours alone. Awa refuses a gate command from a thread it started, and every role is told never to merge. Agents run `gh` with your login, though, so GitHub cannot tell who merged a pull request; keeping agents from merging rests on those instructions until bb can give agent threads a GitHub identity of their own.

## Project 1

### The objective

An objective is a GitHub issue with the `awa:objective` label, on a project board Awa reads. Its body has three headings:

- **Outcome**: what is true when it is done.
- **How we'll know**: the signals in production that show success. Watch reads these later.
- **Limits**: what is out of scope, and an optional `agent-hours: <n>` cap.

Two fields on the board: **Raised by** (You, Watch, Polish) and **Size** (Polish, Feature, Vertical). The existing Stage field shows where the objective is.

An issue missing the Outcome heading cannot start; Awa comments what is missing.

### States

| State | Means | Leaves when |
|---|---|---|
| Open | Raised, not started | You start it, or the scheduler does within budget |
| Discussing | Roles are taking turns | The moderator calls agreement, a dispute, or the turn cap is hit |
| Needs you | A question only you can answer is on the issue | You comment on the issue |
| Spec review | The spec pull request is open | You merge it, request changes, or close it |
| Building | Slices are going through the lifecycle | Every slice's pull request has merged; project 3 adds the ✅ after this |
| Stopped | You closed the spec pull request, or stopped the objective | You resume it |

Requesting changes on the spec pull request returns the objective to Discussing with your review as the first thing every role reads.

### The discussion

- **Roles.** Awa ships five: product, architect, implementer, reviewer, operator, as Markdown files in `plugins/awa/roles/`. Each names its job, its provider and model, and what it must check. A repository adds or replaces roles with files of the same shape in `.bb/awa/roles/`; a file with a default role's name replaces it.
- **Threads.** Each role invited to an objective gets its own bb thread, in the project that has the repository checked out, and keeps it for every turn of that objective. You can open any of them and type to it.
- **Turns.** A turn is one message to one role's thread: the objective, the discussion so far, and the question the moderator gave it. The role's reply is posted as a comment on the issue, headed with the role's name and model and ending "Posted by Awa".
- **The moderator.** After every turn, a moderator thread answers one structured question: the next speaker and what it should address, or `agreed`, or `disputed` with the question and each side's case. It also chooses which roles to invite at the start, and reads any comment you added since the last turn. It does not write the plan.
- **Limits.** Awa, not the moderator, enforces them: at most 12 turns (a setting), and the objective's share of the budget. At the cap, the objective goes to Needs you with the open points.
- **Your comments.** A comment you post on the issue reaches the moderator before it chooses the next speaker, and is quoted to that speaker.

### The spec pull request

On `agreed`, the implementer writes `objectives/<number>-<slug>.md` on the branch `awa/objective-<number>` and opens a draft pull request into the default branch. The spec has these headings, and Awa rejects a spec missing one:

- **Outcome** and **How we'll know**, carried from the issue, sharpened by the discussion.
- **Decisions**: each one with the alternative it beat and why.
- **Slices**, in order. Each has an id, a title, what it depends on, its acceptance criteria, and the checks that prove it.

Awa reads the file. If it can, it comments the slices and their order on the pull request and marks it ready for review, and the objective moves to Spec review. If it cannot, the implementer is told what is missing and fixes the file, and Awa reads it again.

### Hand-off to the build

When you merge the spec pull request, Awa creates one GitHub sub-issue per slice under the objective, titled with the slice's title, its body the slice's criteria and checks. Each sub-issue enters the existing lifecycle at Build, skipping Triage and Plan. Until project 2, Awa starts one slice at a time, in the spec's order, and the next when the previous one merges.

### The budget and the scheduler

- **Measuring.** Awa listens to `thread.active`, `thread.idle` and `thread.failed` for the threads it started, and records each running span against its objective and its source (you, Watch, Polish). The week resets Monday 00:00 in the server's time zone.
- **Scheduling.** A sweep every minute starts at most as many turns and stages as there are free agent slots, in this order: objectives you raised, then concerns, then Awa's proposals, smallest size first. Work Awa raised starts only when the week's budget and the objective's own cap both have time left.
- **Out of budget.** Running turns finish. Self-started objectives show "Paused: budget" until the week resets or you raise the budget. Yours continue.

### The page

Awa's page opens on **Needs you first**:

- A header with the budget used this week, agents running, and what Watch and Polish are doing (until projects 4 and 5, only the budget and agents).
- **Needs you**: each item with its one action: review the spec, answer the dispute, give the ✅, raise the budget.
- **In motion**: every other active objective with who raised it, its state, what is happening now, and its agent-hours.
- An objective opens its own page, **the room**: the discussion as it happens, the roles and links to their threads, the spec and its pull request, and the slices with their stages.
- Today's board and table stay as a second tab.

### Failures

- A role's turn fails: retried once in the same thread, then the objective goes to Needs you with the error.
- GitHub is unreachable: every step is saved as an event in Awa's store before its side effect, so the next sweep retries it; a bb restart resumes the same way.
- The moderator's answer cannot be read: asked once more, then treated as `disputed`.
- You close the spec pull request without merging: the objective stops, and Awa comments why on the issue.

## Code

| Unit | Does |
|---|---|
| `objective.ts` | The objective's states and the discussion's turns as pure transitions, like `lifecycle.ts`: an event in, the next state and one action out; the turn cap |
| `spec.ts` | Reads a spec file into its slices, their order and checks; names what is missing |
| `roles.ts` | Loads the default roles, then the repository's on top |
| `budget.ts` | Running spans into agent-hours per week and per objective; which waiting turn or stage goes next |
| `engine.ts` | The side effects: threads, issue comments, the spec pull request, sub-issues, the sweep |
| `app.tsx` | Needs you first, the room, and the board as a second tab |
| `roles/*.md` | The five default roles |

## Testing

- Unit tests with `node --test`, as today, for every pure unit: each state transition and the actions it returns, the turn cap, a dispute, your comment reaching the moderator, spec parsing on good and broken specs, role overrides, budget arithmetic across a week boundary, and the scheduler's order with full and empty budgets.
- One live run on a sandbox repository: an objective from Open to the spec pull request merged and its first slice in Build, with the comments and the agent-hours as expected.

## Not in project 1

Slices in parallel, the ✅ page, Watch, Polish, and any board other than GitHub Projects.
