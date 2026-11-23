#!/usr/bin/env bash
# Checks the index and every plugin: the same run CI does.
set -euo pipefail
cd "$(dirname "$0")/.."

listed=$(jq -r '.plugins[].source' .bb/plugins.json | sed 's|^\./||' | sort)
present=$(ls -d plugins/*/ | sed 's|/$||' | sort)
if [ "$listed" != "$present" ]; then
    echo ".bb/plugins.json must list exactly the folders in plugins/" >&2
    diff <(echo "$listed") <(echo "$present") >&2
    exit 1
fi

if grep -rnE '^import \{[^}]*\} from "@get-bb/plugin-sdk"' plugins/*/ --include='*.tsx' --include='*.ts' \
    --exclude-dir=node_modules --exclude='server.ts' --exclude='*.test.ts'; then
    echo "a frontend file imports a value from @get-bb/plugin-sdk, which a git install cannot resolve; import from @get-bb/plugin-sdk/app or use import type" >&2
    exit 1
fi

for dir in plugins/*/; do
    (cd "$dir" && pnpm install --frozen-lockfile && pnpm run typecheck && pnpm test)
done
