/** 官网 portfolio 盈亏汇总起点 = journal 权益基准日（与本轮盈亏同期） */
export function syncOfficialPnlSince(exchange, journal) {
  if (!exchange) return;
  const t = journal?.getBaselineSetAt?.();
  exchange.pnlSinceDate = t ? new Date(t).toISOString().slice(0, 10) : null;
}
