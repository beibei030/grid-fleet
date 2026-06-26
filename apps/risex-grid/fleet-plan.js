/**
 * RISEx 专属 fleet：固化三槽 + ATR 定区间 + 中性网格 + 越界重挂
 * （Extended 仍用动态选币；此处按 RISEx 实际挂牌与资金规模单独调参）
 */
import { pickActiveSelections, pickActiveSelectionsValidated, invalidateScannerCache } from './fleet-scanner.js';

/** RISEx 实际可交易候选（固化三槽为主，其余仅作维护备用） */
export const CANDIDATE_NAMES = [
  'BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE',
];

export const ACTIVE_SLOTS = Number(process.env.RISE_ACTIVE_SLOTS || 3);

/** 固化三槽：BTC / ETH / SOL 均分 */
export const FIXED_ALLOC = [
  { token: 'BTC', weight: 1 / 3 },
  { token: 'ETH', weight: 1 / 3 },
  { token: 'SOL', weight: 1 / 3 },
];

export const FLEET_DEFAULTS = {
  /** Full grid mode after quota headroom recovery. */
  BUDGET_USE: Number(process.env.RISE_BUDGET_USE || 0.85),
  SKIP_BAND: 0.10,
  AUTO_RECENTER: process.env.RISE_AUTO_RECENTER === '1',
  AUTO_STOP_OUT_OF_RANGE: false,
  RECENTER_COOLDOWN_MS: 120 * 60 * 1000,
  RANGE_ATR_MULT: 1.35,
  RANGE_MIN_HALF_PCT: Number(process.env.RISE_RANGE_HALF_PCT || 0.024),
  RANGE_MAX_HALF_PCT: Number(process.env.RISE_RANGE_HALF_PCT || 0.024),
  ROTATION_CHECK_MS: 60 * 60 * 1000,
  STOPPED_REPLACE_MS: 4 * 60 * 60 * 1000,
  AUTO_CLOSE_ON_SLOT_EXIT: false,
  /** 与残留平仓一并：撤销不在当前槽内的链上挂单 */
  AUTO_CANCEL_ORPHAN_ORDERS: false,
  /** RISEx 固化：不动态换槽，只补停机空位 */
  FIXED_SLOTS: true,
  FIXED_ALLOC,
  HOT_SWAP_ENABLED: false,
  SCORE_CACHE_MS: 45 * 60 * 1000,
  MIN_KEEP_SCORE: 12,
  HOT_SWAP_MIN_GAP: 10,
  ROTATE_COOLDOWN_MS: 4 * 60 * 60 * 1000,
  TREND_LINKED_MODE: false,
  BLUE_CHIP_BONUS: 12,
  /** 单标保证金不超过权益 28%（与 slice*0.32 单格上限配合） */
  MAX_SLICE_PCT: 0.28,
  /** 铺单保护期：此期间维护器不做 recenter/heal/补槽 */
  SEED_GRACE_MS: 45 * 60 * 1000,
  /** 未满员时补槽最短间隔 */
  FILL_SLOT_COOLDOWN_MS: 20 * 60 * 1000,
};

/** @deprecated 兼容旧引用 */
export const ALLOC = CANDIDATE_NAMES.slice(0, 3).map((name, i) => ({
  name,
  marketId: null,
  weight: [0.38, 0.37, 0.25][i],
  leverage: 5,
  gridCount: 22,
  rangePct: 0.024,
}));

export const BUDGET_USE = FLEET_DEFAULTS.BUDGET_USE;
export const SKIP_BAND = FLEET_DEFAULTS.SKIP_BAND;

function budgetUse() {
  return Number(process.env.RISE_BUDGET_USE || FLEET_DEFAULTS.BUDGET_USE || 0.85);
}

let fleetRestarting = false;
let fleetRestartingSince = 0;

export function isFleetRestarting() {
  return fleetRestarting;
}

export function getFleetLockMeta() {
  if (fleetRestarting && fleetRestartingSince > 0 && Date.now() - fleetRestartingSince > 12 * 60_000) {
    console.warn('[Fleet] 重配锁超时，自动释放');
    fleetRestarting = false;
    fleetRestartingSince = 0;
  }
  return { restarting: fleetRestarting, restartingSince: fleetRestartingSince };
}

export function gridParamsForName(name) {
  const n = String(name || '').toUpperCase();
  /** Full grid mode: 22-grid BTC/ETH/SOL after TX headroom recovers. */
  const gridCount = Number(process.env.RISE_GRID_COUNT) > 0
    ? Math.floor(Number(process.env.RISE_GRID_COUNT))
    : 18;
  if (n.includes('BTC')) return { leverage: 5, gridCount };
  if (n.includes('ETH') || n.includes('SOL')) return { leverage: 5, gridCount };
  if (n.includes('DOGE') || n.includes('BNB')) return { leverage: 5, gridCount };
  return { leverage: 5, gridCount };
}

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
  const halfPct = sel.rangeHalfPct ?? FLEET_DEFAULTS.RANGE_MIN_HALF_PCT;
  const gp = gridParamsForName(sel.name);
  const leverage = sel.leverage ?? gp.leverage;
  const gridCount = sel.gridCount ?? gp.gridCount;
  const weight = sel.weight ?? (1 / ACTIVE_SLOTS);
  const step = m.stepSize || m.minOrderSize || 0.0001;
  const minSz = m.minOrderSize || step;

  const slice = balance * weight;
  const notional = slice * leverage * budgetUse();
  let sizeBase = floorStep(notional / gridCount / price, step);
  if (sizeBase < minSz) sizeBase = minSz;

  const maxRungUsd = (notional / gridCount) * 1.8;
  const orderUsd = sizeBase * price;
  const maxSlice = balance * (FLEET_DEFAULTS.MAX_SLICE_PCT ?? 0.32);
  if (orderUsd > maxRungUsd || orderUsd > maxSlice) {
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
    autoRecenter: process.env.RISE_AUTO_RECENTER === '1' || plan.autoRecenter,
    rangeHalfPct: plan.rangeHalfPct,
    recenterCooldownMs: plan.recenterCooldownMs,
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
  fleet.journal?.ensureBaseline(eq, { force: closeFirst });

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
    // 同槽重配：只撤单，不平仓（避免 restart 把浮盈仓平掉）
    await fleet.stop({ closePosition: false });
    await new Promise((r) => setTimeout(r, 3000));
    for (const p of preview.plans) {
      await exchange.cancelAll?.(p.marketId).catch((e) => {
        console.warn(`[Fleet] ${p.name} 撤旧挂单失败:`, e.message);
      });
      await new Promise((r) => setTimeout(r, 1000));
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

  const started = [];
  const staged = process.env.RISE_STAGED_START !== '0';
  for (const p of preview.plans) {
    if (fleet.bots.get(p.marketId)?.running) {
      started.push({ name: p.name, openOrders: fleet.bots.get(p.marketId).active?.size ?? 0, skipped: true });
      continue;
    }
    try {
      const st = await fleet.start(planToBotConfig(p));
      started.push({
        name: p.name,
        openOrders: st.openOrders,
        score: p.score,
        perRung: p.perRungUsd,
        margin: p.estMarginUsd,
      });
    } catch (e) {
      started.push({ name: p.name, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 5000));
    if (staged && started.some((x) => !x.error && !x.skipped)) break;
  }

  exchange.statsMarketNames = preview.plans.map((p) => p.name);
  return { preview, started, state: fleet.getState() };
  } finally {
    fleetRestarting = false;
    fleetRestartingSince = 0;
  }
}
