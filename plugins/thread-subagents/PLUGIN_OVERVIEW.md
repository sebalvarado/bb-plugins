See what a thread's subagents are doing, and notice when one stalls.

## What you get

- A **Subagents** tab beside a thread that has run subagents: one card per
  subagent with its title, its state (running, stalled, finished or stopped), the time
  since its last step, the initial prompt (collapsed), every follow-up
  instruction, the last steps it took and its final report.
- A chip above the composer while subagents run or stall, such as
  "2 running · 1 stalled". A click opens the tab.
- On each thread row in the sidebar, a small count of running subagents and a
  dot when one has stalled. The sidebar shows it with the row metadata
  experiment on and Organize → Rows → Metadata selected.

## How it works

bb marks a background subagent finished the moment it launches and keeps only
its title. This plugin reads the transcripts Cursor writes for each subagent
of the thread's conversation, read only:

- A subagent is **finished** when its last message is a reply with no tool
  call, **running** when its transcript changed in the last 3 minutes,
  **stalled** when it last changed within a day, and **stopped** after that.
  Stopped subagents sit in a collapsed group at the end of the tab, and the
  chip and the sidebar count only running and stalled ones.
- Its title comes from the task bb recorded when it launched; a subagent with
  no matching task is titled from the first line of its prompt.
- Prompts and reports show as plain text.

Only Cursor threads have transcripts. For other agents the tab lists the
tasks bb recorded, with their title and status only.
