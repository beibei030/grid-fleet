import { maintainFleet } from './fleet-maintain.js';

let fleetPaused = false;

export function isFleetPaused() {
  return fleetPaused;
}

export function setFleetPaused(v) {
  fleetPaused = !!v;
}

/** 暂停：撤全部网格挂单，不平仓；维护任务不再补槽 */
export async function pauseFleet(fleet) {
  setFleetPaused(true);
  await fleet.stop({ closePosition: false });
  return { paused: true, ...fleet.getState() };
}

/** 恢复：解除暂停并尝试补满 3 槽 */
export async function resumeFleet(fleet, exchange) {
  setFleetPaused(false);
  await maintainFleet(fleet, exchange).catch(() => {});
  return { paused: false, ...fleet.getState() };
}

/** 市价平掉账户全部持仓（含残留仓位） */
export async function closeAllPositions(exchange) {
  if (typeof exchange._refreshAllPositions === 'function') {
    await exchange._refreshAllPositions().catch(() => {});
  }
  const positions = exchange.getAllPositions?.() || [];
  const closed = [];
  for (const p of positions) {
    if (!p.marketId) {
      closed.push({ market: p.market, ok: false, error: '未知 marketId' });
      continue;
    }
    try {
      await exchange.closePosition(p.marketId);
      closed.push({ market: p.market, ok: true });
    } catch (e) {
      closed.push({ market: p.market, ok: false, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  await exchange._refreshAllPositions?.().catch(() => {});
  return { closed, count: closed.filter((c) => c.ok).length };
}
