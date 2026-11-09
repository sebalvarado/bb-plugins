Keep a thread's pull request one click away.

## What you get

- A chip in the context row above the composer of every thread whose branch
  has a pull request: its number and title, with the icon in the state's
  colour (open, draft, merged, closed).
- A red dot when checks fail or the branch conflicts, a yellow one while
  checks run.
- A tooltip with the branches, the checks, the review and whether it can
  merge. A click opens the pull request on GitHub.

## How it works

It reads what bb's GitHub PR Status plugin already knows about each
environment's branch, so it needs no token and makes no request of its own.
With GitHub PR Status disabled, or a thread without a pull request, it shows
nothing.
