import {
  ACTIVE_SLOTS,
  FLEET_DEFAULTS,
  buildPlanFromSelection,
  planToBotConfig,
} from './fleet-plan.js';
import { pickActiveSelectionsValidated, invalidateScannerCache } from './fleet-scanner.js';
import { tryHotSwap } from './fleet-rotate.js';

/** 撤净某标的全部挂单（重配前用，带重试） */
export async function cancelMarketOrdersFully(exchange, marketId, { retries = 4, waitMs = 1500 } = {}) {
  for (let i = 0; i < retries; i++) {
    await exchange.cancelAll(marketId).catch(() => {});
    await new Promise((r) => setTimeout(r, waitMs));
    await exchange._refreshAllOpenOrders?.().catch(() => {});
    const left = exchange.getOpenOrdersForMarket?.(marketId)?.length ?? 0;
    if (left === 0) return { ok: true, remaining: 0 };
  }
  const remaining = exchange.getOpenOrdersForMarket?.(marketId)?.length ?? -1;
  return { ok: remaining === 0, remaining };
}

/** 平掉不在当前 3 槽内的持仓（换槽残留） */
async function closeOrphanPositions(exchange, runningBots) {
  if (!FLEET_DEFAULTS.AUTO_CLOSE_ON_SLOT_EXIT) return [];
  const runningIds = new Set(runningBots.map((b) => b.config.marketId));
  const positions = exchange.getAllPositions?.() || [];
  const closed = [];
  for (const p of positions) {
    if (runningIds.has(p.marketId)) continue;
    try {
      await exchange.closePosition(p.marketId);
      closed.push(p.market);
      console.log(`[Fleet] 换槽残留平仓 ${p.market}`);
    } catch (e) {
      console.warn(`[Fleet] 残留平仓失败 ${p.market}:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return closed;
}

/** 撤掉不在当前 3 槽内标的的全部挂单（换槽残留单） */
async function cancelOrphanOrders(exchange, runningBots) {
  if (!FLEET_DEFAULTS.AUTO_CLOSE_ON_SLOT_EXIT) return [];
  await exchange._refreshAllOpenOrders?.().catch(() => {});
  const runningIds = new Set(runningBots.map((b) => b.config.marketId));
  const orders = exchange.getAllOpenOrders?.() || [];
  const orphanMarketIds = new Set();
  for (const o of orders) {
    if (o.marketId != null && !runningIds.has(o.marketId)) orphanMarketIds.add(o.marketId);
  }
  const cancelled = [];
  for (const marketId of orphanMarketIds) {
    const label = orders.find((o) => o.marketId === marketId)?.market || String(marketId);
    try {
      await exchange.cancelAll(marketId);
      cancelled.push(label);
      console.log(`[Fleet] 槽外挂单已撤 ${label}`);
    } catch (e) {
      console.warn(`[Fleet] 槽外撤单失败 ${label}:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (cancelled.length) await exchange._refreshAllOpenOrders?.().catch(() => {});
  return cancelled;
}

/** 清理槽外残留仓位 + 挂单（维护任务 / 重配后调用） */
export async function cleanupSlotOrphans(exchange, runningBots) {
  const [closed, cancelled] = await Promise.all([
    closeOrphanPositions(exchange, runningBots),
    cancelOrphanOrders(exchange, runningBots),
  ]);
  return { closed, cancelled };
}

/** 强制重挂指定标的（撤单重挂，不平仓） */
export async function recenterFleetBots(fleet, exchange, { markets = null, force = true } = {}) {
  const want = markets ? new Set(markets.map(String)) : null;
  const results = [];
  for (const b of fleet.bots.values()) {
    if (!b.running) continue;
    const name = b.config?.displayName || String(b.config?.marketId);
    if (want && !want.has(name)) continue;
    let px = b.lastPrice;
    if (!(px > 0)) {
      try { px = await exchange.getPrice(b.config.marketId); } catch { /* keep */ }
    }
    if (!(px > 0)) {
      results.push({ name, ok: false, error: '无现价' });
      continue;
    }
    let ok = false;
    let err = null;
    try {
      ok = await b.recenter(px, { force });
    } catch (e) {
      err = e.message;
    }
    const st = b.getState();
    results.push({
      name, ok: !!ok, openOrders: st.openOrders, position: st.position?.sizeBase ?? 0, error: err || undefined,
    });
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { results, state: fleet.getState() };
}

/** 定时维护：补空槽、替换长期停止的标的、强制重挂长期越界 */
export async function maintainFleet(fleet, exchange) {
  const { isFleetPaused } = await import('./fleet-control.js');
  const { isFleetRestarting } = await import('./fleet-plan.js');
  const { isFleetRecovering } = await import('./fleet-idle-recover.js');
  if (isFleetPaused()) return { ok: true, action: 'paused' };
  if (isFleetRestarting() || isFleetRecovering()) return { ok: true, action: 'busy' };
  if (typeof exchange._refreshAccount === 'function') {
    await exchange._refreshAccount().catch(() => {});
  }
  const balance = typeof exchange.balance === 'number' ? exchange.balance : null;
  if (balance == null) return { ok: false, reason: 'no balance' };

  const now = Date.now();
  const started = [];

  for (const b of fleet.bots.values()) {
    if (!b.running) continue;

    await b.rebalanceInventory?.().catch((e) => {
      console.warn(`[Fleet] 库存补挂 ${b.config?.displayName}:`, e.message);
    });

    const openN = b._liveOpenOrders?.()?.length ?? 0;
    const expectMin = Math.max(12, (b.config?.gridCount || 22) - 6);
    if (openN === 0 && b.lastPrice) {
      const ok = await b.recenter(b.lastPrice, { force: true }).catch(() => false);
      if (ok) console.log(`[Fleet] ${b.config?.displayName} 无挂单 → 已强制重挂`);
    } else if (openN > 0 && openN < expectMin && b.lastPrice) {
      const ok = await b.recenter(b.lastPrice, { force: true }).catch(() => false);
      if (ok) console.log(`[Fleet] ${b.config?.displayName} 挂单 ${openN}<${expectMin} → 已强制重挂`);
    }

    const dist = b.nearestOrderDistancePct?.();
    if (dist != null && dist > (FLEET_DEFAULTS.NEAR_ORDER_RECENTER_PCT ?? 0.3) && b.lastPrice) {
      const force = dist > (FLEET_DEFAULTS.NEAR_ORDER_FORCE_RECENTER_PCT ?? 0.45);
      const ok = await b.recenter(b.lastPrice, { force }).catch(() => false);
      if (ok) console.log(`[Fleet] ${b.config?.displayName} 挂单偏离现价 ${dist.toFixed(2)}% → 已重挂`);
    }

    if (b.outOfRange && b.outOfRangeSince
      && now - b.outOfRangeSince > 3 * 3600_000
      && (!b.lastRecenterAt || now - b.lastRecenterAt > 3600_000)) {
      await b.recenter(b.lastPrice, { force: true }).catch(() => {});
    }
  }

  for (const [id, b] of [...fleet.bots]) {
    if (b.running) continue;
    if (!b.stoppedAt || now - b.stoppedAt < FLEET_DEFAULTS.STOPPED_REPLACE_MS) continue;
    fleet.bots.delete(id);
  }

  const running = [...fleet.bots.values()].filter((b) => b.running);
  const { closed: orphansClosed, cancelled: orphansCancelled } = await cleanupSlotOrphans(exchange, running);

  const markets = await exchange.getMarkets();
  let swapped = [];

    if (running.length >= ACTIVE_SLOTS) {
    swapped = await tryHotSwap(fleet, exchange, running, balance, markets).catch((e) => {
      console.warn('[Fleet] 热换槽失败:', e.message);
      return [];
    });
    if (swapped.length) {
      exchange.statsMarketNames = [...fleet.bots.values()]
        .filter((b) => b.running)
        .map((b) => b.config.displayName);
      return {
        ok: true, action: 'hot_swap', swapped, closed: orphansClosed, cancelled: orphansCancelled,
        running: fleet.getState().botCount,
      };
    }
    const recentered = running.filter((b) => b.lastRecenterAt && now - b.lastRecenterAt < 60_000).length;
    if (!orphansClosed.length && !orphansCancelled.length && !recentered) {
      return { ok: true, action: 'noop', running: running.length };
    }
    return {
      ok: true,
      action: orphansClosed.length || orphansCancelled.length ? 'cleanup_orphans' : 'maintain',
      closed: orphansClosed,
      cancelled: orphansCancelled,
      running: running.length,
    };
  }

  invalidateScannerCache();
  const runningIds = running.map((b) => b.config.marketId);
  const selections = await pickActiveSelectionsValidated(exchange, {
    slotCount: ACTIVE_SLOTS,
    runningMarketIds: runningIds,
    balance,
    markets,
  });

  for (const sel of selections) {
    if ([...fleet.bots.values()].filter((b) => b.running).length >= ACTIVE_SLOTS) break;
    if (fleet.bots.get(sel.marketId)?.running) continue;

    try {
      const plan = buildPlanFromSelection({ balance, markets, sel });
      await fleet.start(planToBotConfig(plan));
      started.push({ name: plan.name, score: plan.score });
      console.log(`[Fleet] 补槽 ${plan.name}（得分 ${plan.score}）`);
    } catch (e) {
      console.warn(`[Fleet] 补槽 ${sel.name} 失败:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  exchange.statsMarketNames = [...fleet.bots.values()]
    .filter((b) => b.running)
    .map((b) => b.config.displayName);

  return {
    ok: true,
    action: started.length ? 'fill' : (orphansClosed.length || orphansCancelled.length ? 'cleanup_orphans' : 'recenter'),
    started,
    closed: orphansClosed,
    cancelled: orphansCancelled,
    running: fleet.getState().botCount,
  };
}

export function startFleetMaintainer(fleet, exchange, intervalMs = FLEET_DEFAULTS.ROTATION_CHECK_MS) {
  const tick = () => maintainFleet(fleet, exchange).catch((e) => {
    console.warn('[Fleet] 维护任务失败:', e.message);
  });
  setTimeout(tick, 5_000);
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const heal = setInterval(tick, 5 * 60_000);
  heal.unref?.();
  import('./fleet-idle-recover.js').then(({ startFleetIdleWatchdog }) => {
    startFleetIdleWatchdog(fleet, exchange);
  }).catch((e) => console.warn('[Fleet] idle watchdog:', e.message));
  return timer;
}
