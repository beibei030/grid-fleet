import { CANDIDATE_NAMES } from './fleet-plan.js';

function toMs(v) {
  if (v == null) return Date.now();
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e12) return n;
  if (Number.isFinite(n) && n > 1e9) return n * 1000;
  const d = Date.parse(String(v));
  return Number.isFinite(d) ? d : Date.now();
}

function normSide(side) {
  const s = String(side || '').toUpperCase();
  if (s === 'BUY' || s === 'LONG') return 'buy';
  return 'sell';
}

/**
 * 从 Extended /user/trades 回填 journal（按 trade.id 去重，保留最近 MAX_FILLS 条）
 */
export async function backfillJournalFromExchange(exchange, journal, { marketNames } = {}) {
  const names = marketNames?.length ? marketNames : CANDIDATE_NAMES;
  const raw = await exchange.fetchAllTrades(names);
  raw.sort((a, b) => toMs(a.createdTime ?? a.timestamp) - toMs(b.createdTime ?? b.timestamp));

  let added = 0;
  let skipped = 0;
  for (const t of raw) {
    const marketName = String(t.market || '');
    const marketId = exchange.marketIdForName(marketName);
    if (!marketId) { skipped++; continue; }
    const m = exchange.markets.get(marketId);
    const price = Number(t.price);
    const sizeBase = Number(t.qty ?? t.quantity ?? 0);
    if (!(price > 0) || !(sizeBase > 0)) { skipped++; continue; }

    const ok = journal.recordFill({
      id: t.id,
      orderId: t.orderId,
      marketId,
      symbol: m?.displayName || marketName,
      side: normSide(t.side),
      price,
      sizeBase,
      levelIndex: null,
      t: toMs(t.createdTime ?? t.timestamp),
    });
    if (ok) added++; else skipped++;
  }

  return { added, skipped, total: raw.length, markets: names };
}
