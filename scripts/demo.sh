#!/usr/bin/env bash
# End-to-end demo against a live instance. Creates a throwaway account and walks the
# whole loop: login → new → push --new → edit → diff → push → pull → pack → publish
# → new --from. Usage: scripts/demo.sh [instance-url]   (default http://localhost:8787)
set -euo pipefail

URL="${1:-http://localhost:8787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GADGET="node $ROOT/dist/cli/main.js"
DEMO="$(mktemp -d)"
export XDG_CONFIG_HOME="$DEMO/config"
export GADGET_PASSWORD="demo password $RANDOM"
USER="demo$(date +%s)$$"
trap 'rm -rf "$DEMO"' EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "login (create $USER)"
$GADGET login "$URL" --create --username "$USER"
$GADGET doctor

step "scaffold + first push"
cd "$DEMO" && $GADGET new demo-counter && cd demo-counter
$GADGET push --new

step "edit → status → diff → push"
printf '// demo edit\n' >> client.js
$GADGET status
$GADGET diff
$GADGET push

step "second clone pulls identically"
WORKSPACE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('gadget.json','utf8')).workspace)")
mkdir "$DEMO/clone" && cd "$DEMO/clone"
$GADGET pull "$WORKSPACE"
$GADGET status

step "pack → publish → new --from"
cd "$DEMO/demo-counter"
$GADGET pack --out demo.gadget
$GADGET blueprint publish --description "demo counter"
BP_URL=$($GADGET blueprint publish --archive demo.gadget | grep -o 'http[^ ]*/blueprint/[^ ]*')
cd "$DEMO" && $GADGET new from-blueprint --from "$BP_URL"
ls from-blueprint

step "done"
$GADGET list
echo "demo complete"
