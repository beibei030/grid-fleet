import {
  ACTIVE_SLOTS,
  FLEET_DEFAULTS,
  buildPlanFromSelection,
  planToBotConfig,
} from './fleet-plan.js';
import { scoreCandidates, invalidateScannerCache } from './fleet-scanner.js';

/** 满槽时：用高分候选替换当前最低分槽（带冷却与分差门槛） */
export async function tryHotSwap(fleet, exchange, runningBots, balance, markets) {
  if (!FLEET_DEFAULTS.HOT_SWAP_ENABLED || runningBots.length < ACTIVE_SLOTS) return [];

  invalidateScannerCache();
  const scored = await scoreCandidates(exchange, { cacheMs: FLEET_DEFAULTS.SCORE_CACHE_MS });
  const runningIds = new Set(runningBots.map((b) => b.config.marketId));

  const ranked = runningBots.map((bot) => {
    const row = scored.find((r) => r.marketId === bot.config.marketId);
    return {
      bot,
      marketId: bot.config.marketId,
      name: bot.config.displayName,
      score: row?.score ?? 0,
      startedAt: bot.startedAt ?? 0,
    };
  }).sort((a, b) => a.score - b.score);

  const weakest = ranked[0];
  if (!weakest) return [];

  const minGap = FLEET_DEFAULTS.HOT_SWAP_MIN_GAP;
  const minKeep = FLEET_DEFAULTS.MIN_KEEP_SCORE;
  const cooldown = FLEET_DEFAULTS.ROTATE_COOLDOWN_MS;
  const closeOnExit = FLEET_DEFAULTS.AUTO_CLOSE_ON_SLOT_EXIT;

  for (const candidate of scored) {
    if (runningIds.has(candidate.marketId)) continue;
    try {
      buildPlanFromSelection({ balance, markets, sel: { ...candidate, weight: 1 / ACTIVE_SLOTS } });
    } catch {
      continue;
    }

    const gap = candidate.score - weakest.score;
    const age = Date.now() - weakest.startedAt;
    const belowKeep = weakest.score < minKeep;
    const bigGap = gap >= minGap * 2;

    if (!belowKeep && gap < minGap) continue;
    if (age < cooldown && !bigGap) continue;

    await weakest.bot.stop({ closePosition: closeOnExit });
    fleet.bots.delete(weakest.marketId);

    const plan = buildPlanFromSelection({ balance, markets, sel: { ...candidate, weight: 1 / ACTIVE_SLOTS } });
    await fleet.start(planToBotConfig(plan));

    const swap = {
      out: weakest.name,
      in: plan.name,
      outScore: weakest.score,
      inScore: plan.score,
      mode: plan.mode,
    };
    console.log(`[Fleet] 热换槽 ${swap.out}(${swap.outScore}) → ${swap.in}(${swap.inScore}) ${swap.mode}网格`);
    return [swap];
  }

  return [];
}
