#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/decibel-grid"
[ -f .env ] || { echo "Missing .env — cp .env.example .env"; exit 1; }
npm run start
