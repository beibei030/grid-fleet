import type { GridExchangeAdapter, GridMarket } from "./iExchange.js";
import { analyzeTrend } from "./trend.js";
import {
  DEC_CRYPTO_POOL,
  FLEET_DEFAULTS,
  buildPlanFromSelection,
  gridParamsForSymbol,
  rangeHalfFromAtr,
  type FleetSelection,
} from "./fleetPlan.js";
import type { FleetVenueProfile } from "./venueFleetProfile.js";
import { estimateOndoGridCount, measureOndoGridParams, scoreOndoCandidate } from "./ondoGridMeasure.js";

let scoreCache = new Map<string, { ts: number; rows: FleetSelection[] }>();

function cacheKey(exchange: GridExchangeAdapter, names: string[]): string {
  return `${exchange.mode}:${names.join(",")}`;
}

function findMarket(markets: GridMarket[], token: string): GridMarket | undefined {
  const t = token.toUpperCase();
  return markets.find(
    (x) =>
      x.symbol.toUpperCase() === t ||
      x.displayName.toUpperCase() === t ||
      x.displayName.toUpperCase().startsWith(`${t}-`) ||
      x.displayName.toUpperCase().startsWith(`${t}/`)
  );
}

export async function scoreCandidates(
  exchange: GridExchangeAdapter,
  {
    names,
    cacheMs,
    preferSymbols = [],
    profile,
  }: { names: string[]; cacheMs?: number; preferSymbols?: string[]; profile?: FleetVenueProfile }
): Promise<FleetSelection[]> {
  const d = profile?.defaults ?? FLEET_DEFAULTS;
  const effectiveCacheMs = cacheMs ?? profile?.defaults.SCORE_CACHE_MS ?? 3_600_000;
  const gpFn = profile?.gridParams ?? gridParamsForSymbol;
  const [atrLo, atrHi] = profile?.idealAtrPct ?? [0.35, 4];
  const preferBonus = profile?.preferBonus ?? 12;

  const key = `${profile?.id ?? "default"}:${cacheKey(exchange, names)}`;
  const cached = scoreCache.get(key);
  if (cached && Date.now() - cached.ts < effectiveCacheMs) return cached.rows;

  const markets = await exchange.getMarkets();
  const rows: FleetSelection[] = [];

  for (const token of names) {
    const m = findMarket(markets, token);
    if (!m?.lastPrice) continue;

    let score = 5;
    let rangeHalfPct = d.RANGE_MIN_HALF_PCT + 0.005;
    let analysis: Awaited<ReturnType<typeof analyzeTrend>> | null = null;
    let gridCount = gpFn(m.symbol).gridCount;
    let leverage = gpFn(m.symbol).leverage;

    try {
      const candles = await exchange.getCandles(m.marketId, 900, 96);
      if (candles.length >= 30) {
        analysis = analyzeTrend(candles);
        if (profile?.id === "ondo") {
          const prefer = preferSymbols.some((p) => p.toUpperCase() === m.symbol.toUpperCase());
          const ondoScore = scoreOndoCandidate({
            atrPct: analysis.atrPct,
            recommended: analysis.recommended,
            trendStrength: analysis.strength ?? 0,
            prefer,
          });
          score = ondoScore.score;
          rangeHalfPct = ondoScore.rangeHalfPct;
          gridCount = estimateOndoGridCount(analysis.atrPct, rangeHalfPct);
        } else {
          if (analysis.recommended === "neutral") score += 35;
          else score += Math.max(0, 18 - (analysis.strength || 0) * 18);
          const atrVal = analysis.atrPct ?? 1;
          if (atrVal >= atrLo && atrVal <= atrHi) score += 28 - Math.abs(atrVal - (atrLo + atrHi) / 2) * 6;
          else score += 8;
          rangeHalfPct = rangeHalfFromAtr(atrVal, profile);
        }
      }
    } catch {
      /* 默认分 */
    }

    if (profile?.id !== "ondo") {
      const gp = gpFn(m.symbol);
      leverage = gp.leverage;
      gridCount = gp.gridCount;
      if (DEC_CRYPTO_POOL.has(m.symbol.toUpperCase())) {
        rangeHalfPct = d.RANGE_MIN_HALF_PCT;
      }
      if (preferSymbols.some((p) => p.toUpperCase() === m.symbol.toUpperCase())) score += preferBonus;
    }

    rows.push({
      marketId: m.marketId,
      name: m.displayName,
      symbol: m.symbol,
      score: +score.toFixed(2),
      rangeHalfPct,
      leverage,
      gridCount,
      analysis,
      lastPrice: m.lastPrice,
      stepSize: m.stepSize,
      minOrderSize: m.minOrderSize,
    });
  }

  rows.sort((a, b) => b.score - a.score);
  scoreCache.set(key, { ts: Date.now(), rows });
  return rows;
}

export async function pickActiveSelections(
  exchange: GridExchangeAdapter,
  opts: {
    slotCount: number;
    names: string[];
    runningMarketIds?: number[];
    preferSymbols?: string[];
    profile?: FleetVenueProfile;
  }
): Promise<FleetSelection[]> {
  const scored = await scoreCandidates(exchange, {
    names: opts.names,
    preferSymbols: opts.preferSymbols,
    profile: opts.profile,
  });
  const minScore = opts.profile?.defaults.MIN_KEEP_SCORE ?? 12;
  const fixedPool = opts.names.length > 0 && opts.names.length === opts.slotCount;

  if (fixedPool) {
    const picked: FleetSelection[] = [];
    for (const token of opts.names) {
      const row = scored.find((r) => r.symbol.toUpperCase() === token.toUpperCase());
      if (!row || row.score < minScore) continue;
      picked.push({
        ...row,
        weight: 1 / opts.slotCount,
        kept: (opts.runningMarketIds ?? []).includes(row.marketId),
      });
    }
    return picked;
  }

  const picked: FleetSelection[] = [];
  const used = new Set<number>();

  for (const id of opts.runningMarketIds ?? []) {
    const row = scored.find((r) => r.marketId === id);
    if (row && row.score >= minScore) {
      picked.push({ ...row, weight: 1 / opts.slotCount, kept: true });
      used.add(id);
    }
  }

  for (const row of scored) {
    if (picked.length >= opts.slotCount) break;
    if (used.has(row.marketId)) continue;
    picked.push({ ...row, weight: 1 / opts.slotCount, kept: false });
    used.add(row.marketId);
  }

  return picked.slice(0, opts.slotCount);
}

export async function pickActiveSelectionsValidated(
  exchange: GridExchangeAdapter,
  opts: {
    slotCount: number;
    names: string[];
    runningMarketIds?: number[];
    balance: number;
    markets?: GridMarket[];
    preferSymbols?: string[];
    profile?: FleetVenueProfile;
  }
): Promise<FleetSelection[]> {
  const scored = await scoreCandidates(exchange, {
    names: opts.names,
    preferSymbols: opts.preferSymbols,
    profile: opts.profile,
  });
  const minScore = opts.profile?.defaults.MIN_KEEP_SCORE ?? 12;
  const slotCount = opts.slotCount;
  const balance = opts.balance;
  const markets = opts.markets ?? (await exchange.getMarkets());
  const fixedPool = opts.names.length > 0 && opts.names.length === slotCount;

  if (fixedPool) {
    const picked: FleetSelection[] = [];
    for (const token of opts.names) {
      const row = scored.find((r) => r.symbol.toUpperCase() === token.toUpperCase());
      if (!row || row.score < minScore) continue;
      try {
        buildPlanFromSelection({ balance, markets, sel: { ...row, weight: 1 / slotCount }, profile: opts.profile });
        picked.push({
          ...row,
          weight: 1 / slotCount,
          kept: (opts.runningMarketIds ?? []).includes(row.marketId),
        });
      } catch {
        /* skip */
      }
    }
    return picked;
  }

  const picked: FleetSelection[] = [];
  const used = new Set(opts.runningMarketIds ?? []);

  for (const id of opts.runningMarketIds ?? []) {
    const row = scored.find((r) => r.marketId === id);
    if (!row || row.score < minScore) continue;
    try {
      buildPlanFromSelection({ balance, markets, sel: { ...row, weight: 1 / slotCount }, profile: opts.profile });
      picked.push({ ...row, weight: 1 / slotCount, kept: true });
      used.add(id);
    } catch {
      /* skip */
    }
  }

  for (const row of scored) {
    if (picked.length >= slotCount) break;
    if (used.has(row.marketId)) continue;
    try {
      buildPlanFromSelection({ balance, markets, sel: { ...row, weight: 1 / slotCount }, profile: opts.profile });
      picked.push({ ...row, weight: 1 / slotCount, kept: false });
      used.add(row.marketId);
    } catch {
      /* skip */
    }
  }

  return picked.slice(0, slotCount);
}

export function invalidateScannerCache(): void {
  scoreCache.clear();
}
