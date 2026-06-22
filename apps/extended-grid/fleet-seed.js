import { ACTIVE_SLOTS, buildPlanFromSelection, isFleetRestarting, planToBotConfig, FLEET_DEFAULTS } from './fleet-plan.js';
import { pickActiveSelectionsValidated } from './fleet-scanner.js';
import { maintainFleet } from './fleet-maintain.js';

let fleetRecovering = false;
export function isFleetRecoveringSeed() {
  return fleetRecovering;
}

function expectedTotal() {
  const gc = FLEET_DEFAULTS.UNIFIED_GRID_COUNT;
  return ACTIVE_SLOTS * Math.max(6, Math.floor(gc * 0.85));
}

/** 补铺：recenter 空 bot + maintain 补槽 */
export async function recoverFleetSeeding(fleet, exchange) {
  if (isFleetRestarting() || fleetRecovering) return { ok: false, action: 'busy' };
  fleetRecovering = true;
  try {
    for (const b of fleet.bots.values()) {
      if (!b.running || !b.lastPrice) continue;
      const openN = b._liveOpenOrders?.()?.length ?? b.active?.size ?? 0;
      if (openN === 0) {
        await b.recenter(b.lastPrice, { force: true }).catch(() => false);
      }
      const dist = b.nearestOrderDistancePct?.();
      if (dist != null && dist > (FLEET_DEFAULTS.NEAR_ORDER_FORCE_RECENTER_PCT ?? 0.45)) {
        await b.recenter(b.lastPrice, { force: true }).catch(() => false);
      }
    }

    const running = [...fleet.bots.values()].filter((b) => b.running);
    if (running.length < ACTIVE_SLOTS) {
      await exchange._refreshAccount?.().catch(() => {});
      const balance = typeof exchange.balance === 'number' ? exchange.balance : null;
      if (balance != null) {
        const markets = await exchange.getMarkets();
        const selections = await pickActiveSelectionsValidated(exchange, {
          slotCount: ACTIVE_SLOTS,
          runningMarketIds: running.map((b) => b.config.marketId),
          balance,
          markets,
        });
        for (const sel of selections) {
          if ([...fleet.bots.values()].filter((b) => b.running).length >= ACTIVE_SLOTS) break;
          if (fleet.bots.get(sel.marketId)?.running) continue;
          try {
            const plan = buildPlanFromSelection({ balance, markets, sel });
            console.log(`[Fleet] 分阶段启动 ${plan.name}`);
            await fleet.start(planToBotConfig(plan));
            break;
          } catch (e) {
            console.warn(`[Fleet] 分阶段启动 ${sel.name}:`, e.message);
          }
        }
      }
    }

    const maintain = await maintainFleet(fleet, exchange);
    const st = fleet.getState();
    return {
      ok: true,
      action: 'seed',
      openOrders: st.openOrders,
      expected: expectedTotal(),
      maintain,
    };
  } finally {
    fleetRecovering = false;
  }
}
