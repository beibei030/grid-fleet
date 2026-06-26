import { ACTIVE_SLOTS, buildPlanFromSelection, isFleetRestarting, planToBotConfig } from './fleet-plan.js';
import { pickActiveSelectionsValidated } from './fleet-scanner.js';

let fleetRecovering = false;
const lastHealAt = new Map();
const HEAL_GAP_MS = Number(process.env.RISE_HEAL_GAP_MS || 30_000);

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

/** One bounded maintenance step: top up each underfilled running bot by a small batch. */
export async function ensureFleetSeeded(fleet, exchange, { internal = false } = {}) {
  if (isFleetRestarting()) return { ok: false, action: 'restarting' };
  if (!internal && fleetRecovering) return { ok: false, action: 'busy' };
  const results = [];
  const maxOrders = Number(process.env.RISE_TOPUP_BATCH_PER_BOT || 6);
  for (const bot of fleet.bots.values()) {
    if (!botNeedsSeed(bot)) continue;
    const mId = bot.config.marketId;
    const prev = lastHealAt.get(mId) || 0;
    if (Date.now() - prev < HEAL_GAP_MS) continue;
    lastHealAt.set(mId, Date.now());
    const cached = exchange.getCachedOpenOrders?.(bot.config.marketId) || [];
    console.log(`[Fleet] 批量续补 ${bot.config.displayName}（当前 ${cached.length} 单）`);
    if (typeof bot.topUpMissingBatch === 'function') {
      const r = await bot.topUpMissingBatch({ maxOrders }).catch((e) => ({ ok: false, error: e.message }));
      results.push({ market: bot.config.displayName, ...r });
    } else {
      await bot._healMissingRungs?.(cached).catch((e) => {
        console.warn(`[Fleet] 续补 ${bot.config.displayName} 失败:`, e.message);
      });
      results.push({ market: bot.config.displayName, orders: cached.length });
    }
  }
  if (results.length) return { ok: true, action: 'top_up_batch', results };
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

    const missing = selections
      .filter((sel) => !fleet.bots.get(sel.marketId)?.running)
      .slice(0, Math.max(0, ACTIVE_SLOTS - running.length));
    if (missing.length) {
      const started = [];
      const results = await Promise.allSettled(missing.map(async (sel) => {
        const plan = buildPlanFromSelection({ balance, markets, sel });
        console.log(`[Fleet] 并行补槽启动 ${plan.name}`);
        const st = await fleet.start(planToBotConfig(plan));
        return { name: plan.name, openOrders: st.openOrders };
      }));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sel = missing[i];
        if (r.status === 'fulfilled') started.push(r.value);
        else {
          console.warn(`[Fleet] 补槽启动 ${sel.name} 失败:`, r.reason?.message || r.reason);
          started.push({ name: sel.name, error: r.reason?.message || String(r.reason) });
        }
      }
      exchange.statsMarketNames = [...fleet.bots.values()]
        .filter((b) => b.running)
        .map((b) => b.config.displayName);
      return {
        ok: started.some((x) => !x.error),
        action: 'start_missing',
        started,
        seed: seedR,
        running: fleet.getState().botCount,
      };
    }

    return { ok: true, action: 'recover_noop', seed: seedR, running: fleet.getState().botCount };
  } finally {
    fleetRecovering = false;
  }
}
