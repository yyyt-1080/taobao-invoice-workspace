#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22 or newer first: https://nodejs.org/"
  read -r -p "Press Return to close..." _
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13)){console.error("Node.js 22.13+ is required");process.exit(1)}'
npm ci
npx playwright install chromium
if [ ! -f engine/invoice-config.json ]; then cp engine/invoice-config.example.json engine/invoice-config.json; fi
echo
echo "Setup complete. Double-click Start.command, open http://127.0.0.1:4318, then enter your details under “开票资料”."
read -r -p "Press Return to close..." _
