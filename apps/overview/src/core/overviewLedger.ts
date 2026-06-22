import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import type { GridVenueSummary } from "./gridOverview.js";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");
const LEDGER_FILE = path.join(DATA_DIR, "overview-ledger.json");
const MAX_HISTORY = 45;
const MAX_INTRADAY = 96;
const MAX_CHANGES = 40;
const SNAPSHOT_MS = 15 * 60_000;

export interface VenueLedgerView {
  todayRealizedPnl: number;
  todayVolume: number;
  totalRealizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number | null;
  totalVolume: number;
  volumeWindow: string | null;
  equity: number;
  feesPaid: number | null;
}

export interface LedgerDayRow {
  day: string;
  todayRealizedPnl: number;
  todayVolume: number;
  unrealizedPnl: number;
  totalRealizedPnl: number;
  totalVolume: number;
  equity: number;
}

export interface LedgerIntradayPoint {
  t: number;
  todayRealizedPnl: number;
  todayVolume: number;
  equity: number;
}

export interface LedgerChangeRow {
  t: number;
  text: string;
}

export interface OverviewLedger {
  dayKey: string;
  timezone: string;
  combined: VenueLedgerView;
  venues: Record<string, VenueLedgerView>;
  calendar: LedgerDayRow[];
  intraday: LedgerIntradayPoint[];
  changes: LedgerChangeRow[];
}

interface VenueOpenSnap {
  realized: number;
  volume: number;
  equity: number;
}

interface PersistedLedger {
  dayKey: string;
  venueOpen: Record<string, VenueOpenSnap>;
  /** 最近一次交易所口径 realized（禁止回退 gridProfit） */
  lastGood: Record<string, VenueOpenSnap>;
  todayPeak: Record<string, { realized: number; volume: number }>;
  history: LedgerDayRow[];
  intraday: LedgerIntradayPoint[];
  changes: LedgerChangeRow[];
  lastSnapshotAt: number;
}

interface ExtractedMetrics {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number | null;
  volumeTotal: number;
  volumeWindow: string | null;
  equity: number;
  feesPaid: number | null;
  fromLive: boolean;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function dayKey(timeZone = config.overviewTelegram.timezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date()
  );
}

function loadPersisted(): PersistedLedger {
  const key = dayKey();
  try {
    if (!fs.existsSync(LEDGER_FILE)) {
      return {
        dayKey: key,
        venueOpen: {},
        lastGood: {},
        todayPeak: {},
        history: [],
        intraday: [],
        changes: [],
        lastSnapshotAt: 0,
      };
    }
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")) as PersistedLedger;
    return {
      dayKey: raw.dayKey ?? key,
      venueOpen: raw.venueOpen ?? {},
      lastGood: raw.lastGood ?? {},
      todayPeak: raw.todayPeak ?? {},
      history: Array.isArray(raw.history) ? raw.history : [],
      intraday: Array.isArray(raw.intraday) ? raw.intraday : [],
      changes: Array.isArray(raw.changes) ? raw.changes : [],
      lastSnapshotAt: num(raw.lastSnapshotAt),
    };
  } catch {
    return {
      dayKey: key,
      venueOpen: {},
      lastGood: {},
      todayPeak: {},
      history: [],
      intraday: [],
      changes: [],
      lastSnapshotAt: 0,
    };
  }
}

function savePersisted(st: PersistedLedger): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(st, null, 2));
  } catch {
    /* 非关键 */
  }
}

/** 总已实现：仅交易所 official / realizedPnl，绝不使用 gridProfit（会话网格利润） */
export function extractExchangeRealized(
  st: Record<string, unknown> | null | undefined,
  lastGood?: VenueOpenSnap | null
): { value: number; fromLive: boolean } | null {
  if (!st) return null;
  const official = st.official as Record<string, unknown> | null | undefined;
  const live = numOrNull(official?.realizedPnl) ?? numOrNull(st.realizedPnl);
  if (live != null) return { value: live, fromLive: true };
  if (lastGood) return { value: lastGood.realized, fromLive: false };
  return null;
}

function extractFromState(
  st: Record<string, unknown> | null | undefined,
  lastGood?: VenueOpenSnap | null
): ExtractedMetrics | null {
  if (!st) return null;
  const official = st.official as Record<string, unknown> | null | undefined;
  const realizedRaw = extractExchangeRealized(st, lastGood);
  if (!realizedRaw) return null;

  const unrealized = numOrNull(official?.unrealizedPnl) ?? num(st.unrealizedPnl);
  const totalPnl = numOrNull(official?.totalPnl) ?? numOrNull(st.totalPnl);
  const volOfficial = numOrNull(official?.volume);
  const stVol = num(st.volume);
  const volumeTotal =
    volOfficial ??
    (stVol > 0 ? stVol : null) ??
    (lastGood && lastGood.volume > 0 ? lastGood.volume : null) ??
    num((st.stats as { volume?: number } | undefined)?.volume);
  const volumeWindow = official?.statsWindow
    ? str(official.statsWindow)
    : volOfficial != null
      ? "交易所累计"
      : "网格会话累计";
  return {
    realizedPnl: realizedRaw.value,
    unrealizedPnl: unrealized ?? 0,
    totalPnl,
    volumeTotal: volumeTotal ?? 0,
    volumeWindow,
    equity: num(st.equity),
    feesPaid: numOrNull(official?.feesPaid) ?? numOrNull(st.feesPaid),
    fromLive: realizedRaw.fromLive,
  };
}

function pushChange(st: PersistedLedger, text: string): void {
  if (st.changes[0]?.text === text) return;
  st.changes.unshift({ t: Date.now(), text });
  if (st.changes.length > MAX_CHANGES) st.changes.length = MAX_CHANGES;
}

function rolloverDay(st: PersistedLedger, venues: GridVenueSummary[], remoteStates: Map<string, Record<string, unknown>>): void {
  const prevKey = st.dayKey;
  if (!prevKey) return;
  let row: LedgerDayRow = {
    day: prevKey,
    todayRealizedPnl: 0,
    todayVolume: 0,
    unrealizedPnl: 0,
    totalRealizedPnl: 0,
    totalVolume: 0,
    equity: 0,
  };
  for (const v of venues) {
    if (!v.ok) continue;
    const m = extractFromState(remoteStates.get(v.key), st.lastGood?.[v.key]);
    const open = st.venueOpen[v.key];
    if (!m || !open) continue;
    row.todayRealizedPnl += round2(m.realizedPnl - open.realized);
    row.todayVolume += round2(Math.max(0, m.volumeTotal - open.volume));
    row.unrealizedPnl += m.unrealizedPnl;
    row.totalRealizedPnl += m.realizedPnl;
    row.totalVolume += m.volumeTotal;
    row.equity += m.equity;
  }
  row.todayRealizedPnl = round2(row.todayRealizedPnl);
  row.todayVolume = round2(row.todayVolume);
  row.unrealizedPnl = round2(row.unrealizedPnl);
  row.totalRealizedPnl = round2(row.totalRealizedPnl);
  row.totalVolume = round2(row.totalVolume);
  row.equity = round2(row.equity);
  st.history = [row, ...st.history.filter((x) => x.day !== prevKey)].slice(0, MAX_HISTORY);
}

function dayStartMs(dayKeyStr: string, timeZone: string): number {
  return Date.parse(`${dayKeyStr}T00:00:00Z`) - timezoneOffsetMs(timeZone, dayKeyStr);
}

function todayFromOfficialFills(
  rawState: Record<string, unknown> | null | undefined,
  dayKeyStr: string,
  timeZone: string
): { realized: number; volume: number } | null {
  const fills = rawState?.fills;
  if (!Array.isArray(fills) || !fills.length) return null;
  const since = dayStartMs(dayKeyStr, timeZone);
  let realized = 0;
  let volume = 0;
  let n = 0;
  for (const row of fills) {
    if (!row || typeof row !== "object") continue;
    const f = row as { t?: unknown; realizedPnl?: unknown; price?: unknown; size?: unknown; official?: unknown };
    const t = num(f.t);
    if (t < since) continue;
    const rp = numOrNull(f.realizedPnl);
    if (rp == null && !f.official) continue;
    realized += rp ?? 0;
    volume += Math.abs(num(f.price) * num(f.size));
    n += 1;
  }
  if (!n) return null;
  return { realized: round2(realized), volume: round2(volume) };
}

function timezoneOffsetMs(timeZone: string, dayKeyStr: string): number {
  const probe = new Date(`${dayKeyStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(probe);
  const off = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+8";
  const m = off.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 8 * 3600_000;
  const sign = m[1] === "-" ? -1 : 1;
  const h = Number(m[2]) || 0;
  const min = Number(m[3]) || 0;
  return sign * (h * 3600_000 + min * 60_000);
}

function seedVenueOpenFromLastGood(st: PersistedLedger, venues: GridVenueSummary[]): void {
  for (const v of venues) {
    const lg = st.lastGood[v.key];
    if (!lg || st.venueOpen[v.key]) continue;
    st.venueOpen[v.key] = { ...lg };
    st.todayPeak[v.key] = { realized: 0, volume: 0 };
  }
}

function ensureVenueOpen(st: PersistedLedger, key: string, m: ExtractedMetrics): void {
  if (!st.venueOpen[key]) {
    const lg = st.lastGood[key];
    st.venueOpen[key] = lg
      ? { ...lg }
      : { realized: m.realizedPnl, volume: m.volumeTotal, equity: m.equity };
    if (!st.todayPeak[key]) st.todayPeak[key] = { realized: 0, volume: 0 };
  }
}

function computeVenueLedger(
  st: PersistedLedger,
  key: string,
  m: ExtractedMetrics,
  rawState?: Record<string, unknown> | null
): VenueLedgerView {
  ensureVenueOpen(st, key, m);
  let open = st.venueOpen[key]!;

  const gridProfit = numOrNull(rawState?.gridProfit);
  if (
    gridProfit != null &&
    Math.abs(open.realized - gridProfit) < 0.15 &&
    m.realizedPnl > open.realized + 1
  ) {
    const peak = st.todayPeak[key] ?? { realized: 0, volume: 0 };
    pushChange(st, `${key} 日初误记为网格利润，已修正日初基准（保留今日已实现）`);
    open = {
      realized: round2(m.realizedPnl - peak.realized),
      volume: round2(Math.max(0, m.volumeTotal - peak.volume)),
      equity: m.equity,
    };
    st.venueOpen[key] = open;
  }

  if (m.realizedPnl + 0.01 < open.realized) {
    const hasOfficialToday = numOrNull(rawState?.todayOfficialRealized) != null;
    const dip = round2(open.realized - m.realizedPnl);
    // 交易所汇总微抖 / 已有 todayOfficial 时：只同步 open，不清 todayPeak、不写变更记录
    if (hasOfficialToday || (m.fromLive && dip < 5)) {
      st.venueOpen[key] = { ...open, realized: round2(m.realizedPnl), equity: m.equity };
    } else {
      pushChange(st, `${key} 已实现盈亏基准重置，今日从当前重计`);
      open = { realized: m.realizedPnl, volume: m.volumeTotal, equity: m.equity };
      st.venueOpen[key] = open;
      st.todayPeak[key] = { realized: 0, volume: 0 };
    }
  }
  if (m.volumeTotal + 1 < open.volume) {
    open = { ...open, volume: m.volumeTotal };
    st.venueOpen[key] = open;
  }

  const rawTodayRealized = round2(m.realizedPnl - open.realized);
  const rawTodayVolume = round2(Math.max(0, m.volumeTotal - open.volume));
  const peak = st.todayPeak[key] ?? { realized: 0, volume: 0 };
  peak.realized = Math.max(peak.realized, rawTodayRealized);
  peak.volume = Math.max(peak.volume, rawTodayVolume);

  const fillToday = todayFromOfficialFills(rawState, st.dayKey, config.overviewTelegram.timezone);
  if (fillToday != null) {
    peak.realized = Math.max(peak.realized, fillToday.realized);
    peak.volume = Math.max(peak.volume, fillToday.volume);
  }
  const rawTodayOverride = numOrNull(rawState?.todayOfficialRealized);
  if (rawTodayOverride != null) {
    peak.realized = round2(rawTodayOverride);
  }
  const rawTodayVolOverride = numOrNull(rawState?.todayOfficialVolume);
  if (rawTodayVolOverride != null) {
    peak.volume = round2(rawTodayVolOverride);
  }

  st.todayPeak[key] = peak;

  return {
    todayRealizedPnl: peak.realized,
    todayVolume: peak.volume,
    totalRealizedPnl: round2(m.realizedPnl),
    unrealizedPnl: round2(m.unrealizedPnl),
    totalPnl: m.totalPnl != null ? round2(m.totalPnl) : null,
    totalVolume: round2(m.volumeTotal),
    volumeWindow: m.volumeWindow,
    equity: round2(m.equity),
    feesPaid: m.feesPaid != null ? round2(m.feesPaid) : null,
  };
}

function sumVenueViews(views: Record<string, VenueLedgerView>): VenueLedgerView {
  const keys = Object.keys(views);
  const acc: VenueLedgerView = {
    todayRealizedPnl: 0,
    todayVolume: 0,
    totalRealizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    totalVolume: 0,
    volumeWindow: "四所合计",
    equity: 0,
    feesPaid: 0,
  };
  let hasTotalPnl = false;
  let hasFees = false;
  for (const k of keys) {
    const v = views[k]!;
    acc.todayRealizedPnl += v.todayRealizedPnl;
    acc.todayVolume += v.todayVolume;
    acc.totalRealizedPnl += v.totalRealizedPnl;
    acc.unrealizedPnl += v.unrealizedPnl;
    acc.totalVolume += v.totalVolume;
    acc.equity += v.equity;
    if (v.totalPnl != null) {
      acc.totalPnl = (acc.totalPnl ?? 0) + v.totalPnl;
      hasTotalPnl = true;
    }
    if (v.feesPaid != null) {
      acc.feesPaid = (acc.feesPaid ?? 0) + v.feesPaid;
      hasFees = true;
    }
  }
  acc.todayRealizedPnl = round2(acc.todayRealizedPnl);
  acc.todayVolume = round2(acc.todayVolume);
  acc.totalRealizedPnl = round2(acc.totalRealizedPnl);
  acc.unrealizedPnl = round2(acc.unrealizedPnl);
  acc.totalVolume = round2(acc.totalVolume);
  acc.equity = round2(acc.equity);
  if (!hasTotalPnl) acc.totalPnl = null;
  else acc.totalPnl = round2(acc.totalPnl!);
  if (!hasFees) acc.feesPaid = null;
  else acc.feesPaid = round2(acc.feesPaid!);
  const windows = new Set(keys.map((k) => views[k]!.volumeWindow).filter(Boolean));
  acc.volumeWindow = windows.size === 1 ? [...windows][0]! : "多口径合计（各所标注见分所卡片）";
  return acc;
}

export function updateOverviewLedger(
  venues: GridVenueSummary[],
  remoteStates: Map<string, Record<string, unknown> | null | undefined>
): OverviewLedger {
  const st = loadPersisted();
  const key = dayKey();

  if (st.dayKey && st.dayKey !== key) {
    const stateMap = new Map<string, Record<string, unknown>>();
    for (const v of venues) {
      const s = remoteStates.get(v.key);
      if (s) stateMap.set(v.key, s);
    }
    rolloverDay(st, venues, stateMap);
    st.dayKey = key;
    st.venueOpen = {};
    st.todayPeak = {};
    seedVenueOpenFromLastGood(st, venues);
    st.intraday = [];
    pushChange(st, `新交易日 ${key}，今日盈亏/成交量从 0 起计`);
  }
  if (!st.dayKey) st.dayKey = key;

  const views: Record<string, VenueLedgerView> = {};
  for (const v of venues) {
    if (!v.ok) continue;
    const raw = remoteStates.get(v.key);
    const m = extractFromState(raw, st.lastGood?.[v.key]);
    if (!m) continue;
    if (m.fromLive) {
      st.lastGood[v.key] = { realized: m.realizedPnl, volume: m.volumeTotal, equity: m.equity };
    }
    views[v.key] = computeVenueLedger(st, v.key, m, raw);
  }

  const combined = sumVenueViews(views);

  const now = Date.now();
  if (now - st.lastSnapshotAt >= SNAPSHOT_MS) {
    st.intraday.push({
      t: now,
      todayRealizedPnl: combined.todayRealizedPnl,
      todayVolume: combined.todayVolume,
      equity: combined.equity,
    });
    if (st.intraday.length > MAX_INTRADAY) st.intraday.shift();
    st.lastSnapshotAt = now;
  }

  const todayRow: LedgerDayRow = {
    day: key,
    todayRealizedPnl: combined.todayRealizedPnl,
    todayVolume: combined.todayVolume,
    unrealizedPnl: combined.unrealizedPnl,
    totalRealizedPnl: combined.totalRealizedPnl,
    totalVolume: combined.totalVolume,
    equity: combined.equity,
  };

  const calendar = [todayRow, ...st.history.filter((x) => x.day !== key)].slice(0, 14);

  savePersisted(st);

  return {
    dayKey: key,
    timezone: config.overviewTelegram.timezone,
    combined,
    venues: views,
    calendar,
    intraday: [...st.intraday],
    changes: [...st.changes],
  };
}
