#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -d node_modules ]; then echo "Run Setup.command first."; read -r -p "Press Return to close..." _; exit 1; fi
npm start
