import {
  ACTIVE_SLOTS,
  FLEET_DEFAULTS,
} from './fleet-plan.js';
import { pickActiveSelectionsValidated, invalidateScannerCache } from './fleet-scanner.js';
import { tryHotSwap } from './fleet-rotate.js';

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
      console.log(`[Fleet] closed orphan position ${p.market}`);
    } catch (e) {
      console.warn(`[Fleet] close orphan position failed ${p.market}:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return closed;
}

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
      console.log(`[Fleet] cancelled orphan orders ${label}`);
    } catch (e) {
      console.warn(`[Fleet] cancel orphan orders failed ${label}:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (cancelled.length) await exchange._refreshAllOpenOrders?.().catch(() => {});
  return cancelled;
}

export async function cleanupSlotOrphans(exchange, runningBots) {
  const [closed, cancelled] = await Promise.all([
    closeOrphanPositions(exchange, runningBots),
    cancelOrphanOrders(exchange, runningBots),
  ]);
  return { closed, cancelled };
}

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
      results.push({ name, ok: false, error: 'no price' });
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

function botUnderfilled(bot) {
  const h = bot.checkGridHealth?.();
  return !!(h?.underFilled);
}

export async function maintainFleet(fleet, exchange) {
  const { isFleetPaused } = await import('./fleet-control.js');
  const { isFleetRestarting } = await import('./fleet-plan.js');
  const { isFleetRecovering } = await import('./fleet-idle-recover.js');
  const { ensureFleetSeeded, recoverFleetSeeding } = await import('./fleet-seed.js');
  if (isFleetPaused()) return { ok: true, action: 'paused' };
  if (isFleetRestarting() || isFleetRecovering()) return { ok: true, action: 'busy' };
  if (typeof exchange._refreshAccount === 'function') {
    await exchange._refreshAccount().catch(() => {});
  }
  await exchange._refreshAllOpenOrders?.().catch(() => {});
  const balance = typeof exchange.balance === 'number' ? exchange.balance : null;
  if (balance == null) return { ok: false, reason: 'no balance' };

  const now = Date.now();

  for (const b of fleet.bots.values()) {
    if (!b.running) continue;

    await b.rebalanceInventory?.().catch((e) => {
      console.warn(`[Fleet] rebalance ${b.config?.displayName}:`, e.message);
    });

    if (b.config?.autoRecenter && b.outOfRange && b.outOfRangeSince
      && now - b.outOfRangeSince > 3 * 3600_000
      && (!b.lastRecenterAt || now - b.lastRecenterAt > 3600_000)
      && !botUnderfilled(b)) {
      await b.recenter(b.lastPrice, { force: true }).catch(() => {});
    }
  }

  for (const [id, b] of [...fleet.bots]) {
    if (b.running) continue;
    if (!b.stoppedAt || now - b.stoppedAt < FLEET_DEFAULTS.STOPPED_REPLACE_MS) continue;
    fleet.bots.delete(id);
  }

  const running = [...fleet.bots.values()].filter((b) => b.running);
  const anyUnderfilled = running.some((b) => b.isSeeding?.() || botUnderfilled(b));
  if (anyUnderfilled) {
    const seed = await ensureFleetSeeded(fleet, exchange, { internal: true }).catch((e) => ({ ok: false, error: e.message }));
    return { ok: true, action: 'seed', seed, running: running.length };
  }

  const { closed: orphansClosed, cancelled: orphansCancelled } = await cleanupSlotOrphans(exchange, running);
  const markets = await exchange.getMarkets();
  let swapped = [];

  if (running.length >= ACTIVE_SLOTS) {
    swapped = await tryHotSwap(fleet, exchange, running, balance, markets).catch((e) => {
      console.warn('[Fleet] hot swap failed:', e.message);
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

    const gridHealth = [];
    for (const b of running) {
      if (b.isSeeding?.() || botUnderfilled(b)) continue;
      const h = b.checkGridHealth?.();
      if (!h) continue;
      if (h.overFilled || h.hardOverFilled) {
        const cached = b._liveOpenOrders?.() || [];
        const r = await b.trimExcessOrders?.(cached, {
          target: h.softMaxOrders,
          maxCancel: Number(process.env.EXT_CONVERGE_MAX_CANCEL || process.env.RISE_CONVERGE_MAX_CANCEL || 8),
        }).catch((e) => ({ error: e.message }));
        gridHealth.push({ market: b.config.displayName, fix: 'trim_excess', ...r });
      }
    }
    if (gridHealth.length) {
      return { ok: true, action: 'grid_health', gridHealth, closed: orphansClosed, cancelled: orphansCancelled, running: running.length };
    }

    if (!orphansClosed.length && !orphansCancelled.length) {
      return { ok: true, action: 'noop', running: running.length };
    }
    return {
      ok: true,
      action: 'cleanup_orphans',
      closed: orphansClosed,
      cancelled: orphansCancelled,
      running: running.length,
    };
  }

  invalidateScannerCache();
  const recover = await recoverFleetSeeding(fleet, exchange).catch((e) => {
    console.warn('[Fleet] recover seeding failed:', e.message);
    return { ok: false, error: e.message };
  });
  return {
    ok: true,
    action: 'recover',
    recover,
    running: fleet.getState().botCount,
  };
}

export function startFleetMaintainer(fleet, exchange, intervalMs = FLEET_DEFAULTS.ROTATION_CHECK_MS) {
  const tick = () => maintainFleet(fleet, exchange).catch((e) => {
    console.warn('[Fleet] maintain failed:', e.message);
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