import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Level = "info" | "warn" | "error" | "trade" | "risk";

const AUDIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.log");
const AUDIT_LEVELS = new Set<Level>(["trade", "risk", "error", "warn"]);

function appendAudit(entry: { ts: number; level: Level; msg: string }) {
  if (!AUDIT_LEVELS.has(entry.level)) return;
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
  } catch {
    /* 审计写入失败不影响主流程 */
  }
}

const colors: Record<Level, string> = {
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  trade: "\x1b[32m",
  risk: "\x1b[35m",
};
const reset = "\x1b[0m";

export type LogEntry = { ts: number; level: Level; msg: string };

const ring: LogEntry[] = [];
const MAX = 500;

/** 独立网格进程（:8083 / :8084）关闭 TG，避免与 8787 对冲告警混用 */
let telegramMuted = false;
export function muteTelegram(v = true): void {
  telegramMuted = v;
}

/** TG 告警限频（仍写 audit/控制台）；Ondo 等 API 503 连续失败时避免刷屏 */
const TG_NOTIFY_THROTTLE_MS = 3600_000;
const tgNotifyLastAt = new Map<string, number>();

const TG_THROTTLE_RULES: { match: RegExp; key: string }[] = [
  { match: /HTTP 503/i, key: "http_503" },
];

function shouldSkipTelegramNotify(msg: string): boolean {
  for (const rule of TG_THROTTLE_RULES) {
    if (!rule.match.test(msg)) continue;
    const now = Date.now();
    const last = tgNotifyLastAt.get(rule.key) ?? 0;
    if (now - last < TG_NOTIFY_THROTTLE_MS) return true;
    tgNotifyLastAt.set(rule.key, now);
    return false;
  }
  return false;
}

function push(level: Level, msg: string) {
  const entry = { ts: Date.now(), level, msg };
  ring.push(entry);
  if (ring.length > MAX) ring.shift();
  const t = new Date(entry.ts).toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`${colors[level]}[${t}] ${level.toUpperCase()}${reset} ${msg}`);
  appendAudit(entry);
  if (
    !telegramMuted &&
    (level === "risk" || level === "warn" || level === "error") &&
    !shouldSkipTelegramNotify(msg)
  ) {
    void import("../telegram/notify.js").then((m) => m.notifyAlert(level, msg)).catch(() => {});
  }
}

export const log = {
  info: (m: string) => push("info", m),
  warn: (m: string) => push("warn", m),
  error: (m: string) => push("error", m),
  trade: (m: string) => push("trade", m),
  risk: (m: string) => push("risk", m),
  recent: (n = 100): LogEntry[] => ring.slice(-n),
};
