import { analyzeTrend } from './trend.js';
import {
  ACTIVE_SLOTS,
  CANDIDATE_NAMES,
  FLEET_DEFAULTS,
  gridParamsForName,
  unifiedRangeHalfPct,
  buildPlanFromSelection,
} from './fleet-plan.js';

let scoreCache = { ts: 0, rows: [] };

/** 对候选市场打分：震荡优先（保守）或趋势联动（激进） */
export async function scoreCandidates(exchange, { names = CANDIDATE_NAMES, cacheMs } = {}) {
  const ttl = cacheMs ?? FLEET_DEFAULTS.SCORE_CACHE_MS ?? 3_600_000;
  if (scoreCache.rows.length && Date.now() - scoreCache.ts < ttl) return scoreCache.rows;

  const markets = await exchange.getMarkets();
  const rows = [];

  for (const name of names) {
    const m = markets.find((x) => x.name === name || x.displayName === name);
    if (!m?.lastPrice) continue;

    let analysis = null;
    let score = 5;
    let rangeHalfPct = unifiedRangeHalfPct();

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
      }
    } catch { /* 用默认分 */ }

    const gp = gridParamsForName(name);
    const bonus = FLEET_DEFAULTS.BLUE_CHIP_BONUS ?? 12;
    if (['BTC-USD', 'ETH-USD', 'SOL-USD'].includes(name)) score += bonus;
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
} = {}) {
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

/** 带保证金校验的选币；固定三标时按 BTC → ETH → SOL 顺序，不按得分轮换 */
export async function pickActiveSelectionsValidated(exchange, opts) {
  const names = opts.names ?? CANDIDATE_NAMES;
  const slotCount = opts.slotCount ?? ACTIVE_SLOTS;
  const balance = opts.balance;
  const markets = opts.markets ?? await exchange.getMarkets();
  const scored = await scoreCandidates(exchange, { names });
  const fixedOrder = names.length <= slotCount;

  const findRow = (idOrName) => {
    if (typeof idOrName === 'number') return scored.find((r) => r.marketId === idOrName);
    return scored.find((r) => r.name === idOrName || r.name?.startsWith(String(idOrName).split('-')[0]));
  };

  const picked = [];
  const used = new Set(opts.runningMarketIds || []);

  const tryPick = (row, kept) => {
    if (!row || used.has(row.marketId)) return;
    try {
      buildPlanFromSelection({ balance, markets, sel: { ...row, weight: 1 / slotCount } });
      picked.push({ ...row, weight: 1 / slotCount, kept });
      used.add(row.marketId);
    } catch { /* 保证金/最小量不足 */ }
  };

  for (const id of opts.runningMarketIds || []) {
    const row = findRow(id);
    if (!row) continue;
    if (!fixedOrder && row.score < (FLEET_DEFAULTS.MIN_KEEP_SCORE ?? 12)) continue;
    tryPick(row, true);
  }

  const fillSeq = fixedOrder ? names : scored;
  for (const item of fillSeq) {
    if (picked.length >= slotCount) break;
    const row = typeof item === 'string' ? findRow(item) : item;
    if (!row || used.has(row.marketId)) continue;
    tryPick(row, false);
  }

  return picked.slice(0, slotCount);
}

export function invalidateScannerCache() {
  scoreCache = { ts: 0, rows: [] };
}
