import { analyzeTrend } from './trend.js';
import {
  ACTIVE_SLOTS,
  CANDIDATE_NAMES,
  FLEET_DEFAULTS,
  FIXED_ALLOC,
  gridParamsForName,
  rangeHalfFromAtr,
  buildPlanFromSelection,
} from './fleet-plan.js';

let scoreCache = { ts: 0, rows: [] };

function isLiveMarket(m) {
  const dn = String(m?.displayName || m?.name || '');
  return !dn.toLowerCase().includes('deprecated') && Number(m?.lastPrice) > 0;
}

function matchMarket(markets, token) {
  const t = String(token).toUpperCase();
  return markets.find((x) => {
    if (!isLiveMarket(x)) return false;
    const dn = String(x.displayName || x.name || '').toUpperCase();
    const sym = String(x.symbol || '').toUpperCase();
    return dn === t || dn.startsWith(`${t}/`) || dn.startsWith(`${t}-`) || sym === t || sym.startsWith(`${t}/`);
  });
}

function rowForMarket(markets, scoredById, token) {
  const m = matchMarket(markets, token);
  if (!m) return null;
  const row = scoredById.get(m.marketId);
  if (row) return row;
  const gp = gridParamsForName(token);
  return {
    marketId: m.marketId,
    name: m.displayName || token,
    score: 0,
    rangeHalfPct: FLEET_DEFAULTS.RANGE_MIN_HALF_PCT,
    leverage: gp.leverage,
    gridCount: gp.gridCount,
    lastPrice: m.lastPrice,
    stepSize: m.stepSize,
    minOrderSize: m.minOrderSize,
  };
}

function tryPickRow({ balance, markets, row, weight }) {
  buildPlanFromSelection({ balance, markets, sel: { ...row, weight } });
  return { ...row, weight };
}

/** RISEx 固化三槽：按 FIXED_ALLOC 权重，第三槽可 fallback */
export async function pickRiseFixedSelections(exchange, opts = {}) {
  const markets = opts.markets ?? await exchange.getMarkets();
  const balance = opts.balance;
  const slotCount = opts.slotCount ?? ACTIVE_SLOTS;
  const alloc = FLEET_DEFAULTS.FIXED_ALLOC ?? FIXED_ALLOC;
  const scored = await scoreCandidates(exchange, { names: opts.names ?? CANDIDATE_NAMES });
  const scoredById = new Map(scored.map((r) => [r.marketId, r]));
  const picked = [];
  const used = new Set(opts.runningMarketIds || []);

  for (const id of opts.runningMarketIds || []) {
    const row = scoredById.get(id) || [...scoredById.values()].find((r) => r.marketId === id);
    const allocEntry = alloc.find((a) => {
      const m = matchMarket(markets, a.token);
      return m?.marketId === id;
    });
    if (!row || !allocEntry) continue;
    try {
      picked.push({ ...tryPickRow({ balance, markets, row, weight: allocEntry.weight }), kept: true });
      used.add(id);
    } catch { /* 运行中但计划失效，稍后按固化表重补 */ }
  }

  for (const entry of alloc) {
    if (picked.length >= slotCount) break;
    const tokens = [entry.token, ...(entry.fallbacks || [])];
    for (const token of tokens) {
      const m = matchMarket(markets, token);
      if (!m || used.has(m.marketId)) continue;
      const row = rowForMarket(markets, scoredById, token);
      if (!row) continue;
      try {
        picked.push({ ...tryPickRow({ balance, markets, row, weight: entry.weight }), kept: false });
        used.add(m.marketId);
        break;
      } catch { /* 试下一个 fallback */ }
    }
  }

  return picked.slice(0, slotCount);
}

/** 对候选市场打分：震荡优先（保守）或趋势联动（激进） */
export async function scoreCandidates(exchange, { names = CANDIDATE_NAMES, cacheMs } = {}) {
  const ttl = cacheMs ?? FLEET_DEFAULTS.SCORE_CACHE_MS ?? 3_600_000;
  if (scoreCache.rows.length && Date.now() - scoreCache.ts < ttl) return scoreCache.rows;

  const markets = await exchange.getMarkets();
  const rows = [];

  for (const name of names) {
    const m = matchMarket(markets, name);
    if (!m?.lastPrice) continue;

    let analysis = null;
    let score = 5;
    let rangeHalfPct = FLEET_DEFAULTS.RANGE_MIN_HALF_PCT;

    try {
      const candles = await exchange.getCandles(m.marketId, 900, 96);
      if (candles?.length >= 30) {
        analysis = analyzeTrend(candles);
        if (FLEET_DEFAULTS.TREND_LINKED_MODE) {
          if (analysis.recommended === 'neutral') score += 35;
          else score += 22 + (analysis.strength || 0) * 12;
        } else if (analysis.recommended === 'neutral') score += 35;
        else score += Math.max(0, 18 - (analysis.strength || 0) * 18);
        const atr = analysis.atrPct ?? 1;
        if (atr >= 0.35 && atr <= 4) score += 28 - Math.abs(atr - 1.25) * 6;
        else score += 8;
        rangeHalfPct = rangeHalfFromAtr(atr);
      }
    } catch { /* 用默认分 */ }

    const gp = gridParamsForName(name);
    const bonus = FLEET_DEFAULTS.BLUE_CHIP_BONUS ?? 12;
    if (['BTC', 'ETH', 'SOL'].includes(name)) score += bonus;
    else if (['DOGE', 'BNB'].includes(name)) score += 6;
    rows.push({
      marketId: m.marketId,
      name: m.displayName || name,
      score: +score.toFixed(2),
      rangeHalfPct,
      leverage: gp.leverage,
      gridCount: gp.gridCount,
      analysis,
      lastPrice: m.lastPrice,
      stepSize: m.stepSize,
      minOrderSize: m.minOrderSize,
    });
  }

  rows.sort((a, b) => b.score - a.score);
  scoreCache = { ts: Date.now(), rows };
  return rows;
}

/**
 * 选出 ACTIVE_SLOTS 个标的：保留运行中且得分尚可的，空槽从候选池补位
 */
export async function pickActiveSelections(exchange, {
  slotCount = ACTIVE_SLOTS,
  names = CANDIDATE_NAMES,
  runningMarketIds = [],
  balance,
  markets,
} = {}) {
  if (FLEET_DEFAULTS.FIXED_SLOTS && balance != null) {
    return pickRiseFixedSelections(exchange, { slotCount, names, runningMarketIds, balance, markets });
  }
  const scored = await scoreCandidates(exchange, { names });
  const picked = [];
  const used = new Set();

  for (const id of runningMarketIds) {
    const row = scored.find((r) => r.marketId === id);
    if (row && row.score >= (FLEET_DEFAULTS.MIN_KEEP_SCORE ?? 12)) {
      picked.push({ ...row, weight: 1 / slotCount, kept: true });
      used.add(id);
    }
  }

  for (const row of scored) {
    if (picked.length >= slotCount) break;
    if (used.has(row.marketId)) continue;
    picked.push({ ...row, weight: 1 / slotCount, kept: false });
    used.add(row.marketId);
  }

  return picked.slice(0, slotCount);
}

/** 带保证金校验的选币：计划建不出来则顺延下一个 */
export async function pickActiveSelectionsValidated(exchange, opts) {
  if (FLEET_DEFAULTS.FIXED_SLOTS) {
    return pickRiseFixedSelections(exchange, opts);
  }
  const scored = await scoreCandidates(exchange, { names: opts.names });
  const slotCount = opts.slotCount ?? ACTIVE_SLOTS;
  const balance = opts.balance;
  const markets = opts.markets ?? await exchange.getMarkets();
  const picked = [];
  const used = new Set(opts.runningMarketIds || []);

  for (const id of opts.runningMarketIds || []) {
    const row = scored.find((r) => r.marketId === id);
    if (!row || row.score < (FLEET_DEFAULTS.MIN_KEEP_SCORE ?? 12)) continue;
    try {
      buildPlanFromSelection({ balance, markets, sel: { ...row, weight: 1 / slotCount } });
      picked.push({ ...row, weight: 1 / slotCount, kept: true });
      used.add(id);
    } catch { /* 运行中但已不适用，不保留 */ }
  }

  for (const row of scored) {
    if (picked.length >= slotCount) break;
    if (used.has(row.marketId)) continue;
    try {
      buildPlanFromSelection({ balance, markets, sel: { ...row, weight: 1 / slotCount } });
      picked.push({ ...row, weight: 1 / slotCount, kept: false });
      used.add(row.marketId);
    } catch { /* 最小下单量过大等 */ }
  }

  return picked.slice(0, slotCount);
}

export function invalidateScannerCache() {
  scoreCache = { ts: 0, rows: [] };
}
