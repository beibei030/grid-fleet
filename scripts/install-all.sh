#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> extended-grid (optional undici)"
(cd apps/extended-grid && npm install 2>/dev/null || true)

echo "==> risex-grid"
(cd apps/risex-grid && npm install)

echo "==> decibel-grid"
(cd apps/decibel-grid && npm install)

echo "==> overview"
(cd apps/overview && npm install)

echo "==> Done. Copy .env.example → .env in each apps/* and fill credentials."
