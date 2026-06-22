import { ACTIVE_SLOTS, buildPlanFromSelection, isFleetRestarting, planToBotConfig } from './fleet-plan.js';
import { pickActiveSelectionsValidated } from './fleet-scanner.js';

let fleetRecovering = false;
const lastHealAt = new Map();
const HEAL_GAP_MS = 30_000;

export function isFleetRecovering() {
  return fleetRecovering;
}

function targetOrders(bot) {
  return Math.max(6, (bot.config?.gridCount ?? 22) - 2);
}

function botNeedsSeed(bot) {
  if (!bot?.running || bot.isSeeding?.()) return false;
  const h = bot.checkGridHealth?.();
  if (!h) return false;
  return h.underFilled || (h.orderCount ?? 0) < targetOrders(bot);
}

/** One small maintenance step: heal at most one running bot by one rung. */
export async function ensureFleetSeeded(fleet, exchange, { internal = false } = {}) {
  if (isFleetRestarting()) return { ok: false, action: 'restarting' };
  if (!internal && fleetRecovering) return { ok: false, action: 'busy' };
  for (const bot of fleet.bots.values()) {
    if (!botNeedsSeed(bot)) continue;
    const mId = bot.config.marketId;
    const prev = lastHealAt.get(mId) || 0;
    if (Date.now() - prev < HEAL_GAP_MS) continue;
    lastHealAt.set(mId, Date.now());
    const cached = exchange.getCachedOpenOrders?.(bot.config.marketId) || [];
    console.log(`[Fleet] 续补 ${bot.config.displayName}（当前 ${cached.length} 单）`);
    await bot._healMissingRungs?.(cached).catch((e) => {
      console.warn(`[Fleet] 续补 ${bot.config.displayName} 失败:`, e.message);
    });
    return { ok: true, action: 'heal_one', market: bot.config.displayName, orders: cached.length };
  }
  return { ok: true, action: 'seed_noop' };
}

/** Start at most one missing fixed slot. No long all-market restart. */
export async function recoverFleetSeeding(fleet, exchange) {
  if (isFleetRestarting() || fleetRecovering) return { ok: false, action: 'busy' };
  fleetRecovering = true;
  try {
    const seedR = await ensureFleetSeeded(fleet, exchange, { internal: true });
    const running = [...fleet.bots.values()].filter((b) => b.running);
    if (running.length >= ACTIVE_SLOTS) return { ok: true, action: 'seed', seed: seedR, running: running.length };

    await exchange._refreshAccount?.().catch(() => {});
    const balance = typeof exchange.balance === 'number' ? exchange.balance : null;
    if (balance == null) return { ok: false, action: 'no_balance', seed: seedR };

    const markets = await exchange.getMarkets();
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
        console.log(`[Fleet] 分阶段启动 ${plan.name}`);
        const st = await fleet.start(planToBotConfig(plan));
        exchange.statsMarketNames = [...fleet.bots.values()]
          .filter((b) => b.running)
          .map((b) => b.config.displayName);
        return { ok: true, action: 'start_one', started: { name: plan.name, openOrders: st.openOrders }, seed: seedR };
      } catch (e) {
        console.warn(`[Fleet] 分阶段启动 ${sel.name} 失败:`, e.message);
        return { ok: false, action: 'start_one_failed', market: sel.name, error: e.message, seed: seedR };
      }
    }

    return { ok: true, action: 'recover_noop', seed: seedR, running: fleet.getState().botCount };
  } finally {
    fleetRecovering = false;
  }
}
