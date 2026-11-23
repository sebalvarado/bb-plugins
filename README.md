# bb plugins

Plugins for [bb](https://getbb.app), the agent IDE. Each one installs on its own, straight from this repository.

| Plugin | What it does |
|---|---|
| [`awa`](plugins/awa/) | Awa, an orchestrator for agentic development. Today it runs agents from GitHub Projects: boards and tables with filters and saved views, each issue handed to an agent in its own worktree or back to the thread that worked it, and a parent issue's lifecycle from triage to merge |
| [`thread-pull-request`](plugins/thread-pull-request/) | A chip above each thread's composer that links to its pull request, with checks and review in a tooltip |
| [`thread-subagents`](plugins/thread-subagents/) | A thread's subagents in a tab: each one's prompt, follow-ups, last steps and report, with a chip while any runs or stalls |

## Install

```sh
bb plugin install git:https://github.com/sebalvarado/bb-plugins.git@main --plugin <name>
```

bb builds the plugin, checks `main` for updates every six hours, and applies them when you run `bb plugin update <name>`.

Plugins run with full trust inside your bb server. Read the source before you install one.

## Contribute

Issues and pull requests are welcome. [`AGENTS.md`](AGENTS.md) has the rules for the code; agents and people follow the same ones.

To work on a plugin, install it from your clone. bb refuses a second install of a plugin it installed from git, so remove that one first (removing deletes its settings):

```sh
bb plugin remove <name>
bb plugin install path:plugins/<name> --yes
bb plugin dev plugins/<name>        # rebuild and reload on every save
```

`scripts/check.sh` runs what CI runs: the index, the import rule, and each plugin's typecheck and tests.

## License

[MIT](LICENSE)
