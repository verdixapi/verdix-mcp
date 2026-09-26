#!/usr/bin/env bash
# Build verdix-mcp-<version>.mcpb: a one-file desktop extension (Claude
# Desktop: Settings > Extensions, drag it in) that Smithery also accepts
# (`smithery mcp publish <file>.mcpb -n <org/name>`). It bundles src/ plus the
# production node_modules, so it runs without npx or network installs.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(node -p 'require("./package.json").version')"
[ "$(node -p 'require("./manifest.json").version')" = "$VERSION" ] || { echo "manifest.json version != package.json version"; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r manifest.json package.json package-lock.json README.md LICENSE src "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --silent --no-audit --no-fund)
npx -y @anthropic-ai/mcpb@2.1.2 validate "$STAGE/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$STAGE" "verdix-mcp-$VERSION.mcpb"
echo "built $(pwd)/verdix-mcp-$VERSION.mcpb"
