import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import type { GridOverviewPayload, GridVenueSummary } from "./gridOverview.js";
import { tgSend } from "../telegram/notify.js";
import { log } from "../util/logger.js";

const STATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");
const STATE_FILE = path.join(STATE_DIR, "overview-tg-state.json");

interface VenueSnap {
  ok: boolean;
  running: boolean;
  stale: boolean;
  equity: number;
  accountPnl: number | null;
  botCount: number;
  strategy?: string;
}

interface Baseline {
  at: number;
  combined: {
    totalEquity: number;
    totalTodayRealizedPnl: number;
    totalRealizedPnl: number;
    totalUnrealized: number;
    healthyVenues: number;
    runningVenues: number;
    positionCount: number;
  };
  venues: Record<string, VenueSnap>;
}

interface PersistedState {
  baseline: Baseline | null;
  lastDigestKeys: string[];
  alertCooldown: Record<string, number>;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function usd(v: number): string {
  const s = v >= 0 ? "+" : "-";
  return s + "$" + Math.abs(v).toFixed(2);
}

function loadState(): PersistedState {
  try {
    if (!fs.existsSync(STATE_FILE)) return { baseline: null, lastDigestKeys: [], alertCooldown: {} };
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as PersistedState;
  } catch {
    return { baseline: null, lastDigestKeys: [], alertCooldown: {} };
  }
}

function saveState(st: PersistedState): void {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  } catch (e: unknown) {
    log.warn(`overview TG 状态写入失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function snapVenue(v: GridVenueSummary): VenueSnap {
  return {
    ok: v.ok,
    running: v.running,
    stale: !!v.stale,
    equity: v.equity,
    accountPnl: v.accountPnl,
    botCount: v.botCount,
    strategy: v.strategy,
  };
}

function snapPayload(p: GridOverviewPayload): Baseline {
  const venues: Record<string, VenueSnap> = {};
  for (const v of p.venues) venues[v.key] = snapVenue(v);
  return {
    at: Date.now(),
    combined: {
      totalEquity: p.combined.totalEquity,
      totalTodayRealizedPnl: p.combined.totalTodayRealizedPnl,
      totalRealizedPnl: p.combined.totalRealizedPnl,
      totalUnrealized: p.combined.totalUnrealized,
      healthyVenues: p.combined.healthyVenues,
      runningVenues: p.combined.runningVenues,
      positionCount: p.combined.positionCount,
    },
    venues,
  };
}

/** 至少一所在线且有权益，才值得推送（避免本机/聚合失败时发全 0 垃圾消息） */
export function isOverviewPayloadUsable(p: GridOverviewPayload): boolean {
  if (p.combined.healthyVenues < 1) return false;
  if (p.combined.totalEquity < 1) return false;
  return p.venues.some((v) => v.ok && !v.stale && v.equity > 0);
}

function venueLine(v: GridVenueSummary): string {
  const icon = !v.ok ? "❌" : v.stale ? "⏳" : v.running ? "✅" : "⏸";
  const strat = v.strategy && v.strategy !== "grid" ? ` ${v.strategy}` : "";
  const bots = v.strategy === "grid" ? ` ${v.botCount}bot` : strat;
  const ac = v.accounting;
  const pnl = ac
    ? ` 今${usd(ac.todayRealizedPnl)} 总${usd(ac.totalRealizedPnl)} 浮${usd(ac.unrealizedPnl)}`
    : v.unrealizedPnl
      ? ` 浮${usd(v.unrealizedPnl)}`
      : "";
  const err = v.error ? ` (${v.error.slice(0, 40)})` : "";
  return `${icon} ${v.label} :${v.port} $${v.equity.toFixed(0)}${pnl}${bots}${err}`;
}

export function formatOverviewDigest(p: GridOverviewPayload, label: string): string {
  const c = p.combined;
  const L = p.ledger?.combined;
  const lines = [
    `📊 网格总览 · ${label}`,
    `总权益 $${c.totalEquity.toFixed(2)}`,
    `今日已实现 ${usd(L?.todayRealizedPnl ?? c.totalTodayRealizedPnl)} · 总已实现 ${usd(L?.totalRealizedPnl ?? c.totalRealizedPnl)} · 浮盈 ${usd(c.totalUnrealized)}`,
    `今日成交 $${c.totalTodayVolume.toFixed(2)} · 总成交 $${c.totalVolume.toFixed(2)} · 持仓 ${c.positionCount} 笔 · 挂单 ${c.totalOpenOrders ?? 0}`,
    `在线 ${c.healthyVenues}/4 所 · 运行 ${c.runningVenues} 所 · ${c.totalBots} bot` +
      (c.trendStrategies ? ` · ${c.trendStrategies} 趋势` : ""),
    "",
    ...p.venues.map(venueLine),
  ];
  return lines.join("\n");
}

function digestKey(now: Date): string | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.overviewTelegram.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (minute !== config.overviewTelegram.digestMinute) return null;
  if (!config.overviewTelegram.digestHours.includes(hour)) return null;
  return `${get("year")}-${get("month")}-${get("day")}@${hour}`;
}

function canAlert(st: PersistedState, key: string): boolean {
  const last = st.alertCooldown[key] ?? 0;
  const cd = config.overviewTelegram.alertCooldownMin * 60_000;
  return Date.now() - last >= cd;
}

function markAlert(st: PersistedState, key: string): void {
  st.alertCooldown[key] = Date.now();
}

export function detectOverviewAnomalies(prev: Baseline | null, curr: GridOverviewPayload): string[] {
  if (!prev) return [];
  if (!isOverviewPayloadUsable(curr)) {
    if (prev.combined.healthyVenues >= 1 && prev.combined.totalEquity >= 1) {
      return ["总看板暂时无法拉取四所数据（聚合失败或全部离线）"];
    }
    return [];
  }
  const alerts: string[] = [];
  const c = curr.combined;
  const pc = prev.combined;

  if (c.healthyVenues < pc.healthyVenues) {
    alerts.push(`在线所 ${pc.healthyVenues}→${c.healthyVenues}`);
  }
  if (c.runningVenues < pc.runningVenues) {
    alerts.push(`运行所 ${pc.runningVenues}→${c.runningVenues}`);
  }

  const eqDrop = pc.totalEquity - c.totalEquity;
  const eqDropPct = pc.totalEquity > 0 ? (eqDrop / pc.totalEquity) * 100 : 0;
  if (
    eqDrop >= config.overviewTelegram.equityDropUsd ||
    eqDropPct >= config.overviewTelegram.equityDropPct
  ) {
    alerts.push(
      `总权益 ${usd(-eqDrop)} (${eqDropPct.toFixed(1)}%) · $${pc.totalEquity.toFixed(0)}→$${c.totalEquity.toFixed(0)}`
    );
  }

  const prevToday = pc.totalTodayRealizedPnl ?? 0;
  const pnlSwing = Math.abs(c.totalTodayRealizedPnl - prevToday);
  if (pnlSwing >= config.overviewTelegram.accountPnlSwingUsd) {
    alerts.push(`今日已实现波动 ${usd(c.totalTodayRealizedPnl - prevToday)} (${usd(prevToday)}→${usd(c.totalTodayRealizedPnl)})`);
  }

  const posDelta = Math.abs(c.positionCount - pc.positionCount);
  if (posDelta >= config.overviewTelegram.positionDelta) {
    alerts.push(`持仓笔数 ${pc.positionCount}→${c.positionCount}`);
  }

  for (const v of curr.venues) {
    const p = prev.venues[v.key];
    if (!p) continue;
    if (p.ok && !v.ok) alerts.push(`${v.label} :${v.port} 离线${v.error ? ` · ${v.error.slice(0, 50)}` : ""}`);
    else if (p.running && !v.running && v.ok && !v.stale) alerts.push(`${v.label} :${v.port} 停止运行`);
    else if (!p.stale && v.stale) alerts.push(`${v.label} :${v.port} 数据变缓存/不可达`);
    else if (v.ok && p.equity > 0) {
      const vDrop = p.equity - v.equity;
      const vPct = (vDrop / p.equity) * 100;
      if (vDrop >= config.overviewTelegram.venueEquityDropUsd || vPct >= config.overviewTelegram.equityDropPct) {
        alerts.push(`${v.label} 权益 ${usd(-vDrop)} (${vPct.toFixed(1)}%)`);
      }
    }
    if (v.strategy === "grid" && p.botCount > 0 && v.botCount === 0 && v.running) {
      alerts.push(`${v.label} bot 数 ${p.botCount}→0`);
    }
  }

  return alerts;
}

export function startOverviewTelegramScheduler(fetchOverview: () => Promise<GridOverviewPayload>): void {
  if (!config.overviewTelegram.enabled) {
    log.info("总览 Telegram 推送未启用（OVERVIEW_TG_ENABLED + TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_IDS）");
    return;
  }
  if (!config.telegram.botToken || !config.telegram.chatIds.length) {
    log.warn("总览 Telegram：缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_IDS");
    return;
  }

  let state = loadState();
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const payload = await fetchOverview();
      const usable = isOverviewPayloadUsable(payload);
      const now = new Date();
      const dk = digestKey(now);
      if (dk && !state.lastDigestKeys.includes(dk)) {
        if (!usable) {
          log.warn(`总览 TG 跳过定时推送 ${dk}：四所数据不可用`);
        } else {
          const hour = dk.split("@")[1] ?? "";
          const label = `${hour.padStart(2, "0")}:${String(config.overviewTelegram.digestMinute).padStart(2, "0")}`;
          const ok = await tgSend(formatOverviewDigest(payload, label));
          if (ok) {
            state.lastDigestKeys.push(dk);
            if (state.lastDigestKeys.length > 30) state.lastDigestKeys = state.lastDigestKeys.slice(-15);
            state.baseline = snapPayload(payload);
            saveState(state);
            log.info(`总览 TG 定时推送 ${label}`);
          }
        }
      }

      if (state.baseline) {
        const raw = detectOverviewAnomalies(state.baseline, payload);
        const toSend: string[] = [];
        for (const a of raw) {
          const key = a.slice(0, 80);
          if (canAlert(state, key)) {
            toSend.push(a);
            markAlert(state, key);
          }
        }
        if (toSend.length) {
          const msg = ["⚠️ 总览异常变动", ...toSend.map((x) => "• " + x)].join("\n");
          const ok = await tgSend(msg);
          if (ok) {
            state.baseline = snapPayload(payload);
            saveState(state);
            log.warn(`总览 TG 异常推送 ${toSend.length} 条`);
          }
        }
      } else if (usable) {
        state.baseline = snapPayload(payload);
        saveState(state);
      }
    } catch (e: unknown) {
      log.warn(`总览 TG 调度失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  };

  const intervalMs = config.overviewTelegram.checkSec * 1000;
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  const hours = config.overviewTelegram.digestHours.join(",");
  log.info(
    `总览 Telegram 已启动 | 定时 ${hours}点 (${config.overviewTelegram.timezone}) | 异常检测 ${config.overviewTelegram.checkSec}s`
  );
}
