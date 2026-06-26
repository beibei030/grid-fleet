import { ACTIVE_SLOTS, buildPlanFromSelection, isFleetRestarting, planToBotConfig, FLEET_DEFAULTS } from './fleet-plan.js';
import { pickActiveSelectionsValidated } from './fleet-scanner.js';

let fleetRecovering = false;
const lastHealAt = new Map();
const HEAL_GAP_MS = Number(process.env.EXT_HEAL_GAP_MS || process.env.RISE_HEAL_GAP_MS || 30_000);

export function isFleetRecoveringSeed() {
  return fleetRecovering;
}

function minHealthyOrders(bot) {
  const gc = bot?.config?.gridCount ?? FLEET_DEFAULTS.UNIFIED_GRID_COUNT;
  return Math.max(6, Math.floor(gc * 0.85));
}

function botNeedsSeed(bot) {
  if (!bot?.running || bot.isSeeding?.()) return false;
  const h = bot.checkGridHealth?.();
  if (!h) return false;
  return h.underFilled || (h.orderCount ?? 0) < minHealthyOrders(bot);
}

export async function ensureFleetSeeded(fleet, exchange, { internal = false } = {}) {
  if (isFleetRestarting()) return { ok: false, action: 'restarting' };
  if (!internal && fleetRecovering) return { ok: false, action: 'busy' };
  await exchange._refreshAllOpenOrders?.().catch(() => {});

  const results = [];
  const maxOrders = Number(process.env.EXT_TOPUP_BATCH_PER_BOT || process.env.RISE_TOPUP_BATCH_PER_BOT || 6);
  for (const bot of fleet.bots.values()) {
    if (!botNeedsSeed(bot)) continue;
    const mId = bot.config.marketId;
    const prev = lastHealAt.get(mId) || 0;
    if (Date.now() - prev < HEAL_GAP_MS) continue;
    lastHealAt.set(mId, Date.now());
    const before = bot._liveOpenOrders?.()?.length ?? 0;
    if (typeof bot.topUpMissingBatch === 'function') {
      const r = await bot.topUpMissingBatch({ maxOrders }).catch((e) => ({ ok: false, error: e.message }));
      results.push({ market: bot.config.displayName, before, ...r });
    }
  }

  if (results.length) return { ok: true, action: 'top_up_batch', results };
  return { ok: true, action: 'seed_noop' };
}

export async function recoverFleetSeeding(fleet, exchange) {
  if (isFleetRestarting() || fleetRecovering) return { ok: false, action: 'busy' };
  fleetRecovering = true;
  try {
    const seedR = await ensureFleetSeeded(fleet, exchange, { internal: true });
    const running = [...fleet.bots.values()].filter((b) => b.running);
    if (running.length >= ACTIVE_SLOTS) {
      return { ok: true, action: 'seed', seed: seedR, running: running.length };
    }

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

    const missing = selections
      .filter((sel) => !fleet.bots.get(sel.marketId)?.running)
      .slice(0, Math.max(0, ACTIVE_SLOTS - running.length));
    const started = [];
    for (const sel of missing) {
      try {
        const plan = buildPlanFromSelection({ balance, markets, sel });
        const st = await fleet.start(planToBotConfig(plan));
        started.push({ name: plan.name, openOrders: st.openOrders });
      } catch (e) {
        console.warn(`[Fleet] start missing ${sel.name}:`, e.message);
        started.push({ name: sel.name, error: e.message });
      }
    }

    exchange.statsMarketNames = [...fleet.bots.values()]
      .filter((b) => b.running)
      .map((b) => b.config.displayName);

    return {
      ok: started.length ? started.some((x) => !x.error) : true,
      action: started.length ? 'start_missing' : 'recover_noop',
      started,
      seed: seedR,
      running: fleet.getState().botCount,
    };
  } finally {
    fleetRecovering = false;
  }
}