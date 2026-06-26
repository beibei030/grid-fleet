import { config } from "../config.js";
import {
  extractExchangeRealized,
  updateOverviewLedger,
  type OverviewLedger,
  type VenueLedgerView,
} from "./overviewLedger.js";

export interface GridPositionRow {
  market: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  valueUsd: number;
  unrealizedPnl: number;
  leverage: number | null;
  inFleet: boolean;
}

export interface GridVenueSummary {
  key: "extended" | "risex" | "decibel" | "ondo";
  label: string;
  port: number;
  ok: boolean;
  stale?: boolean;
  staleAt?: number;
  unreachable?: boolean;
  error?: string;
  running: boolean;
  botCount: number;
  equity: number;
  balance: number;
  /** 网格 journal 累计格 profit（撮合利润） */
  gridProfit: number;
  /** 重配基准以来的账户盈亏，与各所看板「本轮盈亏」一致 */
  accountPnl: number | null;
  /** 交易所 API 累计盈亏 */
  totalPnl: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
  volume: number;
  volumeWindow: string | null;
  feesPaid: number | null;
  /** @deprecated 用 ledger 今日/总已实现 */
  todayVolume: number;
  todayVolumeEstimated?: boolean;
  /** 交易所口径记账（与 ledger 同步） */
  accounting?: VenueLedgerView;
  openOrders: number;
  /** RISEx：链上全账户挂单（含未运行槽位） */
  accountOpenOrders?: number;
  returnPct: number;
  bots: Array<{
    name: string;
    symbol?: string;
    running: boolean;
    gridProfit: number;
    unrealized: number;
    lastPrice: number;
    outOfRange: boolean;
    openOrders: number;
    gridCount: number | null;
    leverage: number | null;
    lower: number | null;
    upper: number | null;
    rangeHalfPct: number | null;
    skipBand: number | null;
    autoRecenter: boolean | null;
  }>;
  positions: GridPositionRow[];
  /** grid=网格 bot；trend/hybrid=Ondo 趋势策略（:8084） */
  strategy?: "grid" | "trend" | "hybrid";
  fleetHealth?: {
    healthy: boolean;
    phase: string;
    openOrdersRatio: number;
    expectedOrders?: number;
    recommendAction: string;
    lastError?: string | null;
    maintainErrorsLastHour?: number;
    restarting?: boolean;
    recovering?: boolean;
  };
  trend?: {
    symbol: string;
    paused: boolean;
    trend: string;
    recommended: string;
    strength: number;
    activeLeg: string | null;
    lastAction: string | null;
    tpUsd: number | null;
    slUsd: number | null;
    price: number | null;
    rthOpen: boolean;
    dailyFeesUsd: number;
  };
}

export interface GridOverviewCombined {
  totalEquity: number;
  /** @deprecated 用 totalTodayRealizedPnl / totalRealizedPnl */
  totalAccountPnl: number;
  totalGridProfit: number;
  totalTodayRealizedPnl: number;
  totalRealizedPnl: number;
  totalUnrealized: number;
  totalVolume: number;
  totalTodayVolume: number;
  runningVenues: number;
  totalBots: number;
  trendStrategies: number;
  healthyVenues: number;
  staleVenues: number;
  positionCount: number;
  totalPositionValue: number;
  /** 四所交易所挂单合计 */
  totalOpenOrders: number;
  /** 8081–8083 三所网格专用汇总（看板顶栏） */
  gridCore: {
    healthyCount: number;
    activeVenues: number;
    openOrders: number;
    expectedOrders: number;
    totalGridProfit: number;
    totalFees: number;
    autoStatus: "ok" | "busy" | "needs_action";
    summary: string;
  };
}

export interface GridOverviewDisplay {
  headline: {
    todayRealizedPnl: number;
    todayVolume: number;
    totalRealizedPnl: number;
    unrealizedPnl: number;
    balance: number;
    equity: number;
    updatedAt: number;
  };
  gridHealth: {
    running: number;
    total: number;
    healthy: number;
    openOrders: number;
    expectedOrders: number;
    summary: string;
    needsAction: boolean;
  };
  venueCards: Array<{
    key: GridVenueSummary["key"];
    label: string;
    port: number;
    ok: boolean;
    running: boolean;
    status: "ok" | "busy" | "needs_action" | "down";
    statusText: string;
    action: string;
    openOrders: number;
    expectedOrders: number;
    openOrdersRatio: number;
    botCount: number;
    balance: number;
    equity: number;
    todayRealizedPnl: number;
    todayVolume: number;
    totalRealizedPnl: number;
    unrealizedPnl: number;
    gridProfit: number;
    volume: number;
    feesPaid: number | null;
    bots: GridVenueSummary["bots"];
    error?: string;
  }>;
  alerts: string[];
}

const GRID_CORE_KEYS: GridVenueSummary["key"][] = ["extended", "risex", "decibel"];
const DEFAULT_GRID_EXPECTED: Record<string, number> = { extended: 60, risex: 45, decibel: 54 };

function expectedOrdersForVenue(v: GridVenueSummary): number {
  const fh = v.fleetHealth?.expectedOrders;
  if (fh != null && fh > 0) return fh;
  return DEFAULT_GRID_EXPECTED[v.key] ?? 45;
}

function buildGridCore(venues: GridVenueSummary[]): GridOverviewCombined["gridCore"] {
  const grid = venues.filter((v) => GRID_CORE_KEYS.includes(v.key));
  const active = grid.filter((v) => v.ok && !v.stale);
  const healthyCount = active.filter((v) => v.fleetHealth?.healthy).length;
  const openOrders = active.reduce((a, v) => a + v.openOrders, 0);
  const expectedOrders = active.reduce((a, v) => a + expectedOrdersForVenue(v), 0);
  const totalGridProfit = active.reduce((a, v) => a + v.gridProfit, 0);
  const totalFees = active.reduce((a, v) => a + (v.feesPaid ?? 0), 0);

  let autoStatus: GridOverviewCombined["gridCore"]["autoStatus"] = "ok";
  if (active.some((v) => v.fleetHealth?.restarting || v.fleetHealth?.recovering || v.fleetHealth?.phase === "busy")) {
    autoStatus = "busy";
  } else if (active.some((v) => v.fleetHealth && !v.fleetHealth.healthy && v.fleetHealth.recommendAction !== "wait")) {
    autoStatus = "needs_action";
  } else if (healthyCount < active.length) {
    autoStatus = "busy";
  }

  const ratioPct = expectedOrders > 0 ? Math.round((openOrders / expectedOrders) * 100) : 0;
  const summary =
    autoStatus === "ok"
      ? `全自动运行 · ${healthyCount}/${active.length} 所 healthy`
      : autoStatus === "busy"
        ? `铺单/恢复中 · 挂单 ${openOrders}/${expectedOrders}（${ratioPct}%）`
        : `待自愈 · 挂单 ${openOrders}/${expectedOrders}`;

  return {
    healthyCount,
    activeVenues: active.length,
    openOrders,
    expectedOrders,
    totalGridProfit,
    totalFees,
    autoStatus,
    summary,
  };
}

export interface GridOverviewPayload {
  updatedAt: number;
  combined: GridOverviewCombined;
  ledger: OverviewLedger;
  venues: GridVenueSummary[];
  allPositions: Array<GridPositionRow & { venue: string; venueKey: GridVenueSummary["key"]; port: number }>;
  display: GridOverviewDisplay;
}

interface RemoteGridResult {
  ok: boolean;
  error?: string;
  unreachable?: boolean;
  state?: Record<string, unknown> | null;
}

const venueCache = new Map<string, { summary: GridVenueSummary; at: number }>();
const SNAPSHOT_TIMEOUT_MS = 6000;
const STATE_TIMEOUT_MS = 18000;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ ok: true; state: Record<string, unknown> } | { ok: false; status?: number; error: string }> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    }
    return { ok: true, state: (await r.json()) as Record<string, unknown> };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "fetch failed" };
  }
}

/** 优先 /api/snapshot（内存快照），旧进程或无此路由时回退 /api/state */
async function fetchRemoteGridState(url: string, token: string, portLabel: string): Promise<RemoteGridResult> {
  const base = url.replace(/\/$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const snap = await fetchJson(`${base}/api/snapshot`, headers, SNAPSHOT_TIMEOUT_MS);
  if (snap.ok) return { ok: true, state: snap.state };

  if (snap.status !== 404) {
    const state = await fetchJson(`${base}/api/state`, headers, STATE_TIMEOUT_MS);
    if (state.ok) return { ok: true, state: state.state };
    return {
      ok: false,
      error: `${portLabel} ${state.error}`,
      unreachable: true,
    };
  }

  const state = await fetchJson(`${base}/api/state`, headers, STATE_TIMEOUT_MS);
  if (state.ok) return { ok: true, state: state.state };
  return {
    ok: false,
    error: `${portLabel} ${state.error}`,
    unreachable: true,
  };
}

function summarizeBots(st: Record<string, unknown> | null | undefined) {
  const bots = Array.isArray(st?.bots) ? st.bots : [];
  return bots.slice(0, 8).map((b) => {
    const raw = b as Record<string, unknown>;
    const cfg = raw.config as {
      displayName?: string;
      symbol?: string;
      gridCount?: number;
      leverage?: number;
      lower?: number;
      upper?: number;
      rangeHalfPct?: number;
      skipBand?: number;
      autoRecenter?: boolean;
    } | null | undefined;
    const stats = raw.stats as { gridProfit?: number } | undefined;
    const grid = raw.grid as { count?: number } | null | undefined;
    return {
      name: cfg?.displayName ?? cfg?.symbol ?? "—",
      symbol: cfg?.symbol,
      running: !!raw.running,
      gridProfit: num(stats?.gridProfit),
      unrealized: num(raw.unrealizedPnl),
      lastPrice: num(raw.lastPrice),
      outOfRange: !!raw.outOfRange,
      openOrders: num(raw.openOrders),
      gridCount: numOrNull(cfg?.gridCount) ?? numOrNull(grid?.count),
      leverage: numOrNull(cfg?.leverage),
      lower: numOrNull(cfg?.lower),
      upper: numOrNull(cfg?.upper),
      rangeHalfPct: numOrNull(cfg?.rangeHalfPct),
      skipBand: numOrNull(cfg?.skipBand),
      autoRecenter: typeof cfg?.autoRecenter === "boolean" ? cfg.autoRecenter : null,
    };
  });
}

function sideOf(size: number, sideRaw: unknown): "long" | "short" {
  if (sideRaw === "long" || sideRaw === "short") return sideRaw;
  return size >= 0 ? "long" : "short";
}

function isTrendState(st: Record<string, unknown> | null | undefined): boolean {
  const mode = st?.mode;
  return mode === "trend" || mode === "hybrid";
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function extractTrendPositions(st: Record<string, unknown>): GridPositionRow[] {
  const pos = st.position as Record<string, unknown> | null | undefined;
  if (!pos || Math.abs(num(pos.size)) < 1e-12) return [];
  const symbol = str(st.symbol) || "—";
  const size = Math.abs(num(pos.size));
  const mark = num(pos.markPrice);
  return [
    {
      market: symbol,
      side: pos.side === "short" ? "short" : "long",
      size,
      entryPrice: num(pos.entryPrice),
      markPrice: mark,
      valueUsd: num(pos.notionalUsd) || size * mark,
      unrealizedPnl: num(pos.unrealizedPnl),
      leverage: null,
      inFleet: true,
    },
  ];
}

function extractPositions(st: Record<string, unknown> | null | undefined): GridPositionRow[] {
  if (!st) return [];
  if (isTrendState(st)) return extractTrendPositions(st);
  const live = Array.isArray(st.livePositions) ? st.livePositions : [];
  if (live.length) {
    return live
      .map((row) => {
        const p = row as Record<string, unknown>;
        const sizeBase = num(p.sizeBase ?? p.size);
        if (Math.abs(sizeBase) < 1e-12) return null;
        const size = Math.abs(num(p.size ?? p.sizeBase));
        const mark = num(p.markPrice);
        return {
          market: String(p.market ?? p.symbol ?? "—"),
          side: sideOf(sizeBase, p.side),
          size,
          entryPrice: num(p.entryPrice),
          markPrice: mark,
          valueUsd: num(p.valueUsd) || size * mark,
          unrealizedPnl: num(p.unrealizedPnl),
          leverage: p.leverage != null ? num(p.leverage) : null,
          inFleet: p.inFleet !== false,
        };
      })
      .filter(Boolean) as GridPositionRow[];
  }

  const bots = Array.isArray(st.bots) ? st.bots : [];
  return bots
    .map((b) => {
      const raw = b as Record<string, unknown>;
      const cfg = raw.config as { displayName?: string; symbol?: string; leverage?: number } | null;
      const pos = raw.position as { sizeBase?: number; entryPrice?: number; unrealizedPnl?: number; leverage?: number } | null;
      const sizeBase = pos?.sizeBase ?? 0;
      if (Math.abs(sizeBase) < 1e-12) return null;
      const mark = num(raw.lastPrice);
      const size = Math.abs(sizeBase);
      return {
        market: String(cfg?.displayName ?? cfg?.symbol ?? "—"),
        side: sizeBase > 0 ? "long" : "short",
        size,
        entryPrice: num(pos?.entryPrice),
        markPrice: mark,
        valueUsd: size * mark,
        unrealizedPnl: num(pos?.unrealizedPnl ?? raw.unrealizedPnl),
        leverage: num(pos?.leverage ?? cfg?.leverage) || null,
        inFleet: !!raw.running,
      };
    })
    .filter(Boolean) as GridPositionRow[];
}

function summarizeTrend(st: Record<string, unknown>): GridVenueSummary["trend"] {
  return {
    symbol: str(st.symbol) || "—",
    paused: !!st.paused,
    trend: str(st.trend) || "—",
    recommended: str(st.recommended) || "neutral",
    strength: num(st.strength),
    activeLeg: st.activeLeg != null ? str(st.activeLeg) : null,
    lastAction: st.lastAction != null ? str(st.lastAction) : null,
    tpUsd: numOrNull(st.tpUsd),
    slUsd: numOrNull(st.slUsd),
    price: numOrNull(st.price),
    rthOpen: !!st.rthOpen,
    dailyFeesUsd: num(st.dailyFeesUsd),
  };
}

function summarizeVenue(
  key: GridVenueSummary["key"],
  label: string,
  port: number,
  remote: RemoteGridResult
): GridVenueSummary {
  const st = remote.ok ? remote.state : null;
  const bots = Array.isArray(st?.bots) ? st.bots : [];
  const trendMode = isTrendState(st);
  const positions = extractPositions(st);
  const pos = st?.position as { unrealizedPnl?: number } | null | undefined;
  const official = st?.official as Record<string, unknown> | null | undefined;
  const strategy = trendMode ? (st!.mode as "trend" | "hybrid") : "grid";
  const fh = (st?.fleetHealth ?? (st?.fleetMeta as { fleetHealth?: unknown })?.fleetHealth) as
    | GridVenueSummary["fleetHealth"]
    | undefined;
  const realizedRaw = trendMode ? null : extractExchangeRealized(st);
  const realizedPnl = realizedRaw?.value ?? null;

  return {
    key,
    label,
    port,
    ok: remote.ok,
    unreachable: remote.unreachable,
    error: remote.error,
    running: trendMode ? !!st?.running && !st?.paused : !!st?.running,
    botCount: trendMode ? 0 : num(st?.botCount) || bots.length,
    equity: num(st?.equity),
    balance: num(st?.balance),
    gridProfit: trendMode ? 0 : num(st?.gridProfit),
    accountPnl: trendMode ? null : numOrNull(st?.accountPnl),
    totalPnl: trendMode ? null : numOrNull(st?.totalPnl),
    unrealizedPnl: trendMode ? num(pos?.unrealizedPnl) : num(st?.unrealizedPnl),
    realizedPnl: realizedPnl ?? 0,
    volume: trendMode ? 0 : num(st?.volume),
    volumeWindow: official?.statsWindow
      ? str(official.statsWindow)
      : numOrNull(official?.volume) != null
        ? "交易所累计"
        : "网格会话累计",
    feesPaid: numOrNull(official?.feesPaid) ?? numOrNull(st?.feesPaid),
    todayVolume: 0,
    openOrders: num(st?.openOrders),
    accountOpenOrders: trendMode ? undefined : numOrNull(st?.accountOpenOrders) ?? undefined,
    returnPct: trendMode ? 0 : num(st?.returnPct),
    bots: trendMode ? [] : summarizeBots(st),
    positions,
    strategy,
    fleetHealth: fh,
    trend: trendMode ? summarizeTrend(st!) : undefined,
  };
}

function venueStatus(v: GridVenueSummary): GridOverviewDisplay["venueCards"][number]["status"] {
  if (!v.ok || v.stale) return "down";
  const fh = v.fleetHealth;
  if (!fh) return v.running ? "busy" : "needs_action";
  if (fh.restarting || fh.recovering || fh.phase === "busy") return "busy";
  if (fh.healthy) return "ok";
  return fh.recommendAction && fh.recommendAction !== "wait" ? "needs_action" : "busy";
}

function venueStatusText(v: GridVenueSummary): string {
  if (!v.ok) return `不可达${v.error ? `: ${v.error}` : ""}`;
  if (v.stale) return "使用缓存数据";
  const fh = v.fleetHealth;
  if (!v.running) return "未运行";
  if (!fh) return "运行中";
  if (fh.restarting) return "重启中";
  if (fh.recovering) return "恢复中";
  if (fh.healthy) return "正常维护";
  if (fh.phase === "seeding") return "挂单不足";
  if (fh.phase === "paused") return "已暂停";
  return String(fh.phase || "运行中");
}

function buildDisplay(
  venues: GridVenueSummary[],
  ledger: OverviewLedger,
  combined: GridOverviewCombined,
  updatedAt: number
): GridOverviewDisplay {
  const cards = venues.map((v) => {
    const expectedOrders = expectedOrdersForVenue(v);
    const ratio = v.fleetHealth?.openOrdersRatio ?? (expectedOrders > 0 ? Math.min(1, v.openOrders / expectedOrders) : 0);
    const ac = v.accounting;
    const status = venueStatus(v);
    return {
      key: v.key,
      label: v.label,
      port: v.port,
      ok: v.ok,
      running: v.running,
      status,
      statusText: venueStatusText(v),
      action: v.fleetHealth?.recommendAction ?? (v.running ? "wait" : "seed"),
      openOrders: v.openOrders,
      expectedOrders,
      openOrdersRatio: Math.round(ratio * 1000) / 1000,
      botCount: v.botCount,
      balance: v.balance,
      equity: v.equity,
      todayRealizedPnl: ac?.todayRealizedPnl ?? 0,
      todayVolume: ac?.todayVolume ?? v.todayVolume,
      totalRealizedPnl: ac?.totalRealizedPnl ?? v.realizedPnl,
      unrealizedPnl: ac?.unrealizedPnl ?? v.unrealizedPnl,
      gridProfit: v.gridProfit,
      volume: ac?.totalVolume ?? v.volume,
      feesPaid: v.feesPaid,
      bots: v.bots,
      error: v.error,
    };
  });

  const alerts = cards
    .filter((v) => v.status === "needs_action" || v.status === "down")
    .map((v) => `${v.label}: ${v.statusText}，挂单 ${v.openOrders}/${v.expectedOrders}，建议 ${v.action}`);

  const total = cards.length;
  const running = cards.filter((v) => v.ok && v.running).length;
  const healthy = cards.filter((v) => v.status === "ok").length;
  const openOrders = cards.reduce((a, v) => a + v.openOrders, 0);
  const expectedOrders = cards.reduce((a, v) => a + v.expectedOrders, 0);
  const needsAction = alerts.length > 0;
  const summary = needsAction
    ? `三所 ${running}/${total} 运行，${healthy}/${total} 正常；${alerts.join("；")}`
    : `三所 ${running}/${total} 运行，${healthy}/${total} 正常，挂单 ${openOrders}/${expectedOrders}`;

  return {
    headline: {
      todayRealizedPnl: ledger.combined.todayRealizedPnl,
      todayVolume: ledger.combined.todayVolume,
      totalRealizedPnl: ledger.combined.totalRealizedPnl,
      unrealizedPnl: ledger.combined.unrealizedPnl,
      balance: cards.reduce((a, v) => a + v.balance, 0),
      equity: combined.totalEquity,
      updatedAt,
    },
    gridHealth: {
      running,
      total,
      healthy,
      openOrders,
      expectedOrders,
      summary,
      needsAction,
    },
    venueCards: cards,
    alerts,
  };
}

function withVenueCache(key: string, summary: GridVenueSummary, remoteOk: boolean): GridVenueSummary {
  if (remoteOk) {
    venueCache.set(key, { summary: { ...summary, stale: false, staleAt: undefined }, at: Date.now() });
    return summary;
  }
  const cached = venueCache.get(key);
  if (!cached) return summary;
  return {
    ...cached.summary,
    ok: true,
    stale: true,
    staleAt: cached.at,
    error: summary.error,
  };
}

export async function buildGridOverview(): Promise<GridOverviewPayload> {
  const sources = [
    {
      key: "extended" as const,
      label: "Extended",
      port: 8081,
      url: config.gridFleet.url,
      token: config.gridFleet.token,
    },
    {
      key: "risex" as const,
      label: "RISEx",
      port: 8082,
      url: config.risexGridFleet.url,
      token: config.risexGridFleet.token,
    },
    {
      key: "decibel" as const,
      label: "Decibel",
      port: 8083,
      url: config.decGridFleet.url,
      token: config.decGridFleet.token,
    },
  ];

  const results = await Promise.all(
    sources.map((s) => fetchRemoteGridState(s.url, s.token, `:${s.port}`))
  );

  const remoteStates = new Map<string, Record<string, unknown> | null | undefined>();
  const venues = sources.map((s, i) => {
    remoteStates.set(s.key, results[i]!.ok ? results[i]!.state : null);
    const raw = summarizeVenue(s.key, s.label, s.port, results[i]!);
    return withVenueCache(s.key, raw, results[i]!.ok);
  });

  const ledger = updateOverviewLedger(venues, remoteStates);
  for (const v of venues) {
    const ac = ledger.venues[v.key];
    if (ac) {
      v.accounting = ac;
      v.todayVolume = ac.todayVolume;
      v.realizedPnl = ac.totalRealizedPnl;
      v.unrealizedPnl = ac.unrealizedPnl;
      v.volume = ac.totalVolume;
    }
  }

  const allPositions = venues.flatMap((v) =>
    v.positions.map((p) => ({
      ...p,
      venue: v.label,
      venueKey: v.key,
      port: v.port,
    }))
  );

  const combined: GridOverviewCombined = {
    totalEquity: venues.reduce((a, v) => a + (v.ok ? v.equity : 0), 0),
    totalAccountPnl: venues.reduce((a, v) => a + (v.ok && v.accountPnl != null ? v.accountPnl : 0), 0),
    totalGridProfit: venues.reduce((a, v) => a + (v.ok ? v.gridProfit : 0), 0),
    totalTodayRealizedPnl: ledger.combined.todayRealizedPnl,
    totalRealizedPnl: ledger.combined.totalRealizedPnl,
    totalUnrealized: ledger.combined.unrealizedPnl,
    totalVolume: ledger.combined.totalVolume,
    totalTodayVolume: ledger.combined.todayVolume,
    runningVenues: venues.filter((v) => v.ok && v.running).length,
    totalBots: venues.reduce((a, v) => a + (v.ok && v.strategy === "grid" ? v.botCount : 0), 0),
    trendStrategies: venues.filter((v) => v.ok && v.strategy !== "grid" && v.running).length,
    healthyVenues: venues.filter((v) => v.ok && !v.stale && (v.fleetHealth?.healthy ?? v.running)).length,
    staleVenues: venues.filter((v) => v.ok && v.stale).length,
    positionCount: allPositions.length,
    totalPositionValue: allPositions.reduce((a, p) => a + p.valueUsd, 0),
    totalOpenOrders: venues.reduce((a, v) => a + (v.ok ? v.openOrders : 0), 0),
    gridCore: buildGridCore(venues),
  };

  const updatedAt = Date.now();
  const display = buildDisplay(venues, ledger, combined, updatedAt);

  return {
    updatedAt,
    combined,
    ledger,
    venues,
    allPositions,
    display,
  };
}
