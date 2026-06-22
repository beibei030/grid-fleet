import {
  ACTIVE_SLOTS,
  FLEET_DEFAULTS,
} from './fleet-plan.js';
import { tryHotSwap } from './fleet-rotate.js';

function inSeedGrace(bot) {
  return bot.running && bot.startedAt && Date.now() - bot.startedAt < FLEET_DEFAULTS.SEED_GRACE_MS;
}

function botUnderfilled(bot) {
  const h = bot.checkGridHealth?.();
  return !!(h?.underFilled || (h && h.orderCount < Math.max(6, (bot.config?.gridCount ?? 14) - 4)));
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

/** 撤销不在当前 3 槽内的链上挂单（面板不展示，但占保证金/可能误成交） */
async function cancelOrphanOrders(exchange, runningBots, fleet) {
  if (!FLEET_DEFAULTS.AUTO_CLOSE_ON_SLOT_EXIT) return [];
  if (FLEET_DEFAULTS.AUTO_CANCEL_ORPHAN_ORDERS === false) return [];
  if (!runningBots.length || typeof exchange.fetchAllOpenOrders !== 'function') return [];

  const runningIds = new Set(runningBots.map((b) => b.config.marketId));
  let open = [];
  try {
    open = await exchange.fetchAllOpenOrders();
  } catch (e) {
    console.warn('[Fleet] 读取全账户挂单失败:', e.message);
    return [];
  }

  const byMarket = new Map();
  for (const o of open) {
    const mId = Number(o.marketId);
    if (!mId || runningIds.has(mId)) continue;
    const name = exchange.markets.get(mId)?.displayName ?? `M${mId}`;
    const prev = byMarket.get(mId) ?? { name, count: 0 };
    prev.count += 1;
    byMarket.set(mId, prev);
  }

  const cancelled = [];
  for (const [mId, { name, count }] of byMarket) {
    try {
      await exchange.cancelAll(mId);
      cancelled.push({ market: name, count });
      console.log(`[Fleet] 槽外挂单撤销 ${name}（${count} 单）`);
      fleet?.journal?.recordAlert?.({ message: `槽外挂单已撤 ${name}（${count} 单）` });
    } catch (e) {
      console.warn(`[Fleet] 槽外挂单撤销失败 ${name}:`, e.message);
      fleet?.journal?.recordAlert?.({ message: `槽外挂单撤销失败 ${name}: ${e.message}` });
    }
    await new Promise((r) => setTimeout(r, 900));
  }

  exchange._orphanOrderMarkets = [...byMarket.entries()].map(([marketId, v]) => ({
    marketId,
    market: v.name,
    count: v.count,
  }));
  return cancelled;
}

function hasOrphanCleanup(closed, cancelled) {
  return (closed?.length ?? 0) > 0 || (cancelled?.length ?? 0) > 0;
}

/** 定时维护：补空槽、替换长期停止的标的、强制重挂长期越界 */
export async function maintainFleet(fleet, exchange) {
  const { isFleetPaused } = await import('./fleet-control.js');
  const { isFleetRestarting } = await import('./fleet-plan.js');
  const { isFleetRecovering, ensureFleetSeeded, recoverFleetSeeding } = await import('./fleet-seed.js');
  if (isFleetPaused()) return { ok: true, action: 'paused' };
  if (isFleetRestarting()) return { ok: true, action: 'restarting' };
  if (isFleetRecovering()) return { ok: true, action: 'recovering' };
  if (typeof exchange._refreshAccount === 'function') {
    await exchange._refreshAccount().catch(() => {});
  }
  const balance = typeof exchange.balance === 'number' ? exchange.balance : null;
  if (balance == null) return { ok: false, reason: 'no balance' };

  const now = Date.now();

  for (const b of fleet.bots.values()) {
    if (!b.running) continue;
    if (b.outOfRange && b.outOfRangeSince
      && now - b.outOfRangeSince > 3 * 3600_000
      && (!b.lastRecenterAt || now - b.lastRecenterAt > 3600_000)
      && !inSeedGrace(b) && !botUnderfilled(b)) {
      await b.recenter(b.lastPrice, { force: true }).catch(() => {});
    }
  }

  for (const [id, b] of [...fleet.bots]) {
    if (b.running) continue;
    if (!b.stoppedAt || now - b.stoppedAt < FLEET_DEFAULTS.STOPPED_REPLACE_MS) continue;
    fleet.bots.delete(id);
  }

  const running = [...fleet.bots.values()].filter((b) => b.running);

  const anySeeding = running.some((b) => b.isSeeding?.() || inSeedGrace(b) || botUnderfilled(b));
  if (anySeeding) {
    const seed = await ensureFleetSeeded(fleet, exchange, { internal: true }).catch((e) => ({ ok: false, error: e.message }));
    return { ok: true, action: 'seed', seed, running: running.length };
  }

  let ordersCancelled = [];
  let orphansClosed = [];
  if (running.length >= ACTIVE_SLOTS) {
    ordersCancelled = await cancelOrphanOrders(exchange, running, fleet);
    orphansClosed = await closeOrphanPositions(exchange, running);
  }

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
      return { ok: true, action: 'hot_swap', swapped, closed: orphansClosed, ordersCancelled, running: fleet.getState().botCount };
    }

    const gridHealth = [];
    for (const b of running) {
      if (b.isSeeding?.() || inSeedGrace(b) || botUnderfilled(b)) continue;
      const h = b.checkGridHealth?.();
      if (!h) continue;
      if (h.detached && (h.detachedMs >= 3 * 60 * 1000 || (h.detachedUp && h.maxBuy != null && b.lastPrice - h.maxBuy > h.spacing * 4))) {
        const ok = await b.recenter(b.lastPrice, { force: true }).catch(() => false);
        if (ok) gridHealth.push({ market: b.config.displayName, fix: 'recenter' });
      } else if (!h.buysBelow || !h.sellsAbove) {
        const cached = exchange.getCachedOpenOrders?.(b.config.marketId) || [];
        await b._healMissingRungs?.(cached).catch(() => {});
        await b._ensureInventorySells?.().catch(() => {});
        await b._ensureInventoryBuys?.().catch(() => {});
        gridHealth.push({ market: b.config.displayName, fix: 'heal' });
      }
    }
    if (gridHealth.length) {
      return { ok: true, action: 'grid_health', gridHealth, closed: orphansClosed, ordersCancelled, running: running.length };
    }

    if (!hasOrphanCleanup(orphansClosed, ordersCancelled)) {
      return { ok: true, action: 'noop', running: running.length };
    }
    return { ok: true, action: 'close_orphans', closed: orphansClosed, ordersCancelled, running: running.length };
  }

  if (running.length < ACTIVE_SLOTS) {
    const last = fleet._lastFillAttempt ?? 0;
    if (Date.now() - last < FLEET_DEFAULTS.FILL_SLOT_COOLDOWN_MS) {
      return { ok: true, action: 'fill_cooldown', running: running.length };
    }
    fleet._lastFillAttempt = Date.now();
    const recover = await recoverFleetSeeding(fleet, exchange).catch((e) => {
      console.warn('[Fleet] 补槽续铺失败:', e.message);
      return { ok: false, error: e.message };
    });
    return {
      ok: true,
      action: 'recover',
      recover,
      running: fleet.getState().botCount,
    };
  }

  return { ok: true, action: 'noop', running: running.length };
}

export function startFleetMaintainer(fleet, exchange, intervalMs = FLEET_DEFAULTS.ROTATION_CHECK_MS) {
  const tick = () =>
    maintainFleet(fleet, exchange).catch((e) => {
      import('./fleet-idle-recover.js').then(({ recordMaintainError }) => recordMaintainError(e.message)).catch(() => {});
    });
  setTimeout(tick, 30_000);
  setTimeout(tick, 120_000);
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const idle = setInterval(tick, Number(process.env.RISE_MAINTAIN_MS || 120_000));
  idle.unref?.();
  import('./fleet-idle-recover.js').then(({ startFleetIdleWatchdog }) => {
    startFleetIdleWatchdog(fleet, exchange);
  }).catch((e) => console.warn('[Fleet] idle watchdog:', e.message));
  return timer;
}
