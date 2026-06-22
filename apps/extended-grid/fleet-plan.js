/**
 * 固定三标 fleet：22 格 / ±2.4% / 5x / 85% 占用（积极版）
 */
import { pickActiveSelections, pickActiveSelectionsValidated, invalidateScannerCache } from './fleet-scanner.js';
import { syncOfficialPnlSince } from './pnlSince.js';
import { cleanupSlotOrphans, cancelMarketOrdersFully } from './fleet-maintain.js';

/** 固定跑这三个标的（与 ACTIVE_SLOTS=3 一一对应，不轮换到其他币） */
export const FIXED_SLOT_NAMES = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
export const CANDIDATE_NAMES = [...FIXED_SLOT_NAMES];

export const ACTIVE_SLOTS = 3;

let fleetRestarting = false;
let fleetRestartingSince = 0;

export function isFleetRestarting() {
  return fleetRestarting;
}

export function getFleetLockMeta() {
  if (fleetRestarting && fleetRestartingSince > 0 && Date.now() - fleetRestartingSince > 10 * 60_000) {
    console.warn('[Fleet] 重配锁超时，自动释放');
    fleetRestarting = false;
    fleetRestartingSince = 0;
  }
  return { restarting: fleetRestarting, restartingSince: fleetRestartingSince };
}

export const FLEET_DEFAULTS = {
  /** 积极版：24 格 / ±2.4% / 5x / 80% 占用（单格间距 > 2×fee） */
  UNIFIED_LEVERAGE: 5,
  UNIFIED_GRID_COUNT: 24,
  UNIFIED_RANGE_HALF_PCT: 0.024,
  BUDGET_USE: 0.80,
  SKIP_BAND: 0.10,
  AUTO_RECENTER: true,
  AUTO_STOP_OUT_OF_RANGE: false,
  RECENTER_COOLDOWN_MS: 30 * 60 * 1000,
  RANGE_ATR_MULT: 1.35,
  RANGE_MIN_HALF_PCT: 0.03,
  RANGE_MAX_HALF_PCT: 0.06,
  ROTATION_CHECK_MS: 45 * 60 * 1000,
  /** 最近挂单距现价超过此值 → 维护任务触发 recenter */
  NEAR_ORDER_RECENTER_PCT: 0.3,
  NEAR_ORDER_FORCE_RECENTER_PCT: 0.45,
  STOPPED_REPLACE_MS: 2 * 60 * 60 * 1000,
  AUTO_CLOSE_ON_SLOT_EXIT: true,
  /** 折中：关热换槽、中性网格、大币加成、45 分钟扫描 */
  HOT_SWAP_ENABLED: false,
  SCORE_CACHE_MS: 45 * 60 * 1000,
  MIN_KEEP_SCORE: 12,
  HOT_SWAP_MIN_GAP: 10,
  ROTATE_COOLDOWN_MS: 2 * 60 * 60 * 1000,
  TREND_LINKED_MODE: false,
  BLUE_CHIP_BONUS: 12,
};

/** @deprecated 兼容旧引用 */
export const ALLOC = CANDIDATE_NAMES.map((name) => ({
  name,
  marketId: null,
  weight: 1 / 3,
  leverage: FLEET_DEFAULTS.UNIFIED_LEVERAGE,
  gridCount: FLEET_DEFAULTS.UNIFIED_GRID_COUNT,
  rangePct: FLEET_DEFAULTS.UNIFIED_RANGE_HALF_PCT,
}));

export function unifiedRangeHalfPct() {
  return FLEET_DEFAULTS.UNIFIED_RANGE_HALF_PCT;
}

export function gridParamsForName(_name) {
  return {
    leverage: FLEET_DEFAULTS.UNIFIED_LEVERAGE,
    gridCount: FLEET_DEFAULTS.UNIFIED_GRID_COUNT,
  };
}

export const BUDGET_USE = FLEET_DEFAULTS.BUDGET_USE;
export const SKIP_BAND = FLEET_DEFAULTS.SKIP_BAND;

export function rangeHalfFromAtr(atrPct) {
  const atr = Number(atrPct) || 1;
  const half = (atr / 100) * FLEET_DEFAULTS.RANGE_ATR_MULT;
  return Math.min(
    FLEET_DEFAULTS.RANGE_MAX_HALF_PCT,
    Math.max(FLEET_DEFAULTS.RANGE_MIN_HALF_PCT, half),
  );
}

function floorStep(val, step) {
  const s = Number(step) || 0.0001;
  if (!s) return val;
  return Math.floor(val / s) * s;
}

function priceBand(price, halfPct) {
  return { lower: +(price * (1 - halfPct)).toFixed(2), upper: +(price * (1 + halfPct)).toFixed(2) };
}

export function buildPlanFromSelection({ balance, markets, sel }) {
  const m = markets.find((x) => x.marketId === sel.marketId);
  if (!m?.lastPrice) throw new Error(`市场 ${sel.name} 不可用`);

  const price = m.lastPrice;
  const halfPct = sel.rangeHalfPct ?? unifiedRangeHalfPct();
  const gp = gridParamsForName(sel.name);
  const leverage = sel.leverage ?? gp.leverage;
  const gridCount = sel.gridCount ?? gp.gridCount;
  const weight = sel.weight ?? (1 / ACTIVE_SLOTS);
  const step = m.stepSize || m.minOrderSize || 0.0001;
  const minSz = m.minOrderSize || step;

  const slice = balance * weight;
  const notional = slice * leverage * BUDGET_USE;
  let sizeBase = floorStep(notional / gridCount / price, step);
  if (sizeBase < minSz) sizeBase = minSz;

  const maxRungUsd = (notional / gridCount) * 1.8;
  const orderUsd = sizeBase * price;
  if (orderUsd > maxRungUsd || orderUsd > slice * (FLEET_DEFAULTS.MAX_RUNG_SLICE_RATIO ?? 0.32)) {
    throw new Error(`${sel.name} 单格名义过大（~${orderUsd.toFixed(1)}U），跳过`);
  }

  const { lower, upper } = priceBand(price, halfPct);
  const mid = (lower + upper) / 2;
  const spacing = (upper - lower) / gridCount;
  const estMargin = (gridCount * sizeBase * mid) / leverage;

  let mode = 'neutral';
  if (FLEET_DEFAULTS.TREND_LINKED_MODE && sel.analysis?.recommended) {
    const r = sel.analysis.recommended;
    if (r === 'long' || r === 'short') mode = r;
  }

  return {
    marketId: m.marketId,
    name: sel.name,
    weight,
    score: sel.score,
    sliceUsd: +slice.toFixed(2),
    mode,
    lower,
    upper,
    rangeHalfPct: halfPct,
    gridCount,
    sizeBase: +sizeBase.toFixed(8),
    leverage,
    skipBand: SKIP_BAND,
    autoStopOutOfRange: FLEET_DEFAULTS.AUTO_STOP_OUT_OF_RANGE,
    autoRecenter: FLEET_DEFAULTS.AUTO_RECENTER,
    recenterCooldownMs: FLEET_DEFAULTS.RECENTER_COOLDOWN_MS,
    price: +price.toFixed(2),
    spacingPct: +((spacing / price) * 100).toFixed(2),
    perRungUsd: +(spacing * sizeBase).toFixed(3),
    estMarginUsd: +estMargin.toFixed(1),
  };
}

export function planToBotConfig(plan) {
  return {
    marketId: plan.marketId,
    mode: plan.mode,
    lower: plan.lower,
    upper: plan.upper,
    gridCount: plan.gridCount,
    sizeBase: plan.sizeBase,
    leverage: plan.leverage,
    skipBand: plan.skipBand,
    autoStopOutOfRange: plan.autoStopOutOfRange,
    autoRecenter: plan.autoRecenter,
    rangeHalfPct: plan.rangeHalfPct,
    recenterCooldownMs: plan.recenterCooldownMs,
    onBreakRange: 'shiftGrid',
  };
}

/**
 * @param {{ balance: number, markets: Array, selections: Array }}
 */
export function buildFleetPlans({ balance, markets, selections }) {
  const bal = Number(balance);
  if (!(bal > 0)) throw new Error('无效余额，无法规划 fleet');
  if (!selections?.length) throw new Error('无可用标的（候选均不满足保证金/最小下单量）');

  const plans = selections.map((sel) => buildPlanFromSelection({ balance: bal, markets, sel }));
  const totalMargin = plans.reduce((a, p) => a + p.estMarginUsd, 0);

  return {
    balance: +bal.toFixed(2),
    totalEstMarginUsd: +totalMargin.toFixed(1),
    marginBufferUsd: +(bal - totalMargin).toFixed(1),
    activeSlots: ACTIVE_SLOTS,
    candidatePool: CANDIDATE_NAMES,
    plans,
  };
}

export async function buildFleetPlansAuto(exchange, balance) {
  const markets = await exchange.getMarkets();
  const runningIds = [...(exchange._fleetRunningIds || [])];
  const selections = await pickActiveSelections(exchange, {
    slotCount: ACTIVE_SLOTS,
    runningMarketIds: runningIds,
  });
  return buildFleetPlans({ balance, markets, selections });
}

export async function restartFleet(fleet, exchange, { closeFirst = true } = {}) {
  if (fleetRestarting) {
    getFleetLockMeta();
    if (fleetRestarting) throw new Error('舰队重配进行中，请稍候');
  }
  fleetRestarting = true;
  fleetRestartingSince = Date.now();
  try {
  if (typeof exchange._refreshAccount === 'function') {
    await exchange._refreshAccount().catch(() => {});
  }
  const balance = typeof exchange.balance === 'number' ? exchange.balance : null;
  if (balance == null) throw new Error('读不到账户余额');
  const eq = typeof exchange.equity === 'number' ? exchange.equity : balance;
  fleet.journal?.ensureBaseline(eq);
  syncOfficialPnlSince(exchange, fleet.journal);

  const runningIds = [...fleet.bots.values()].filter((b) => b.running).map((b) => b.config.marketId);
  exchange._fleetRunningIds = runningIds;

  const markets = await exchange.getMarkets();
  const selections = await pickActiveSelectionsValidated(exchange, {
    slotCount: ACTIVE_SLOTS,
    runningMarketIds: closeFirst ? [] : runningIds,
    balance,
    markets,
  });
  const preview = buildFleetPlans({ balance, markets, selections });

  const closeOnExit = FLEET_DEFAULTS.AUTO_CLOSE_ON_SLOT_EXIT;
  if (closeFirst) {
    await fleet.stop({ closePosition: closeOnExit });
    await new Promise((r) => setTimeout(r, 2000));
    for (const p of preview.plans) {
      await cancelMarketOrdersFully(exchange, p.marketId);
    }
  } else {
    const targetIds = new Set(preview.plans.map((p) => p.marketId));
    for (const [id, bot] of [...fleet.bots]) {
      if (bot.running && !targetIds.has(id)) {
        await bot.stop({ closePosition: closeOnExit });
        fleet.bots.delete(id);
      }
    }
  }

  const stillRunning = [...fleet.bots.values()].filter((b) => b.running);
  await cleanupSlotOrphans(exchange, stillRunning).catch(() => {});

  const started = [];
  for (const p of preview.plans) {
    const bot = fleet.bots.get(p.marketId);
    if (bot?.running) {
      await bot.stop({ closePosition: false });
      await cancelMarketOrdersFully(exchange, p.marketId);
    }
    try {
      const st = await fleet.start(planToBotConfig(p));
      started.push({ name: p.name, openOrders: st.openOrders, score: p.score, perRung: p.perRungUsd, margin: p.estMarginUsd });
    } catch (e) {
      started.push({ name: p.name, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  exchange.statsMarketNames = preview.plans.map((p) => p.name);
  return { preview, started, state: fleet.getState() };
  } finally {
    fleetRestarting = false;
    fleetRestartingSince = 0;
  }
}
