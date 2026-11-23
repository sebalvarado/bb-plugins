# Working in this repository

Plugins for bb. Read the `bb-plugin-authoring` skill before you change one; the installed bb's SDK declarations are the contract.

## Where a plugin goes

- One folder per plugin, named by its id: `plugins/<id>/`, with `"name": "bb-plugin-<id>"` and `"private": true` in its `package.json`.
- `bb plugin new <id>`, run in `plugins/`, scaffolds `bb-plugin-<id>/`; rename the folder to `<id>/` and add it to `.bb/plugins.json` and the table in `README.md`.
- Each plugin has a `PLUGIN_OVERVIEW.md` and a skill under `skills/` that documents its commands. Change them in the same commit as the behaviour they describe.

## Rules

- **A plugin knows no particular project.** Anything specific to a repository (its stages, its checks, its names) is read from that repository, such as `.bb/lifecycle.json`, never written into the plugin.
- **Run only in checkouts bb knows.** Take a path from the RPC, check that it is one of the project's checkouts, and never pass it to a shell.
- **The frontend imports only `@get-bb/plugin-sdk/app` as a value.** A git install builds without `devDependencies`, and bb provides only the app entry at runtime; take anything else from `@get-bb/plugin-sdk` with `import type`. The server entry may import it.
- Use pnpm. Commit `pnpm-lock.yaml`, and approve any dependency install script in `pnpm-workspace.yaml` (`pnpm approve-builds`); `node_modules/` and `dist/` stay out of git.
- **Awa's work lives on GitHub.** An objective is an issue, its discussion is the issue's comments, its spec is a file merged through a pull request. Awa's own store holds only what it needs to resume: events, threads, agent-hours.
- **Awa's code, not an agent, enforces every limit:** turn caps, the budget, agents at once, and gates. Agents decide what to say, never whether a limit applies. Watch and Polish only raise objectives; only the build loop changes code. The design is in [`docs/specs/`](docs/specs/).
- Each plugin has `typecheck` and `test` scripts. `scripts/check.sh` runs them for every plugin, checks that `.bb/plugins.json` lists exactly the folders in `plugins/`, and enforces the import rule. CI runs it on every pull request.
