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

/** å¯¹å€™é€‰å¸‚åœºæ‰“åˆ†ï¼šéœ‡è¡ä¼˜å…ˆï¼ˆä¿å®ˆï¼‰æˆ–è¶‹åŠ¿è”åŠ¨ï¼ˆæ¿€è¿›ï¼‰ */
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
    } catch { /* ç”¨é»˜è®¤åˆ† */ }

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
 * é€‰å‡º ACTIVE_SLOTS ä¸ªæ ‡çš„ï¼šä¿ç•™è¿è¡Œä¸­ä¸”å¾—åˆ†å°šå¯çš„ï¼Œç©ºæ§½ä»Žå€™é€‰æ± è¡¥ä½
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

/** å¸¦ä¿è¯é‡‘æ ¡éªŒçš„é€‰å¸ï¼›å›ºå®šä¸‰æ ‡æ—¶æŒ‰ BTC â†’ ETH â†’ SOL é¡ºåºï¼Œä¸æŒ‰å¾—åˆ†è½®æ¢ */
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
  const used = new Set();

  const tryPick = (row, kept) => {
    if (!row || used.has(row.marketId)) return;
    try {
      buildPlanFromSelection({ balance, markets, sel: { ...row, weight: 1 / slotCount } });
      picked.push({ ...row, weight: 1 / slotCount, kept });
      used.add(row.marketId);
    } catch { /* ä¿è¯é‡‘/æœ€å°é‡ä¸è¶³ */ }
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
