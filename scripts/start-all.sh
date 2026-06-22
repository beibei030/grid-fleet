#!/usr/bin/env bash
# 后台启动四进程（Mac/Linux）。日志在 logs/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/logs"
cd "$ROOT"

nohup "$ROOT/scripts/start-extended.sh" >"$ROOT/logs/extended.log" 2>&1 &
nohup "$ROOT/scripts/start-risex.sh"    >"$ROOT/logs/risex.log" 2>&1 &
nohup "$ROOT/scripts/start-decibel.sh"  >"$ROOT/logs/decibel.log" 2>&1 &
sleep 2
nohup "$ROOT/scripts/start-overview.sh" >"$ROOT/logs/overview.log" 2>&1 &
echo "Started. tail -f logs/*.log"
