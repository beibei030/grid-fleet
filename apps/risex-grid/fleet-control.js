import { maintainFleet } from './fleet-maintain.js';
import { recoverFleetSeeding } from './fleet-seed.js';

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

/** 恢复：解除暂停；欠单则续铺/补槽，否则常规维护 */
export async function resumeFleet(fleet, exchange) {
  setFleetPaused(false);
  const running = [...fleet.bots.values()].filter((b) => b.running).length;
  if (!running) {
    const { restartFleet } = await import('./fleet-plan.js');
    const r = await restartFleet(fleet, exchange, { closeFirst: false });
    return { paused: false, ...r, state: fleet.getState() };
  }
  const recover = await recoverFleetSeeding(fleet, exchange).catch((e) => ({ ok: false, error: e.message }));
  await maintainFleet(fleet, exchange).catch(() => {});
  return { paused: false, recover, ...fleet.getState() };
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
    const gap = exchange.orderGapMs ?? 11000;
    await new Promise((r) => setTimeout(r, gap));
  }
  await exchange._refreshAllPositions?.().catch(() => {});
  return { closed, count: closed.filter((c) => c.ok).length };
}
