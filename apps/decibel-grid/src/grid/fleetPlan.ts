import type { GridMarket } from "./iExchange.js";
import type { FleetVenueProfile } from "./venueFleetProfile.js";
import { measureOndoGridParams } from "./ondoGridMeasure.js";
import { getVenueFleetProfile } from "./venueFleetProfile.js";

export const FLEET_DEFAULTS = {
  BUDGET_USE: 0.85,
  SKIP_BAND: 0.1,
  AUTO_RECENTER: true,
  AUTO_STOP_OUT_OF_RANGE: false,
  RECENTER_COOLDOWN_MS: 30 * 60 * 1000,
  RANGE_ATR_MULT: 1.35,
  RANGE_MIN_HALF_PCT: 0.03,
  RANGE_MAX_HALF_PCT: 0.06,
  ROTATION_CHECK_MS: 45 * 60 * 1000,
  STOPPED_REPLACE_MS: 2 * 60 * 60 * 1000,
};

/** Decibel 三标池统一网格：格数、半宽、杠杆一致 */
export const DEC_CRYPTO_POOL = new Set(["ETH", "BTC", "SOL"]);
export const DEC_CRYPTO_GRID = { leverage: 5, gridCount: 22, rangeHalfPct: 0.024 };

export interface FleetSelection {
  marketId: number;
  name: string;
  symbol: string;
  score: number;
  rangeHalfPct: number;
  leverage: number;
  gridCount: number;
  weight?: number;
  kept?: boolean;
  analysis?: unknown;
  lastPrice?: number;
  stepSize?: number;
  minOrderSize?: number;
}

export interface FleetPlanItem {
  marketId: number;
  name: string;
  symbol: string;
  weight: number;
  score: number;
  mode: "neutral";
  lower: number;
  upper: number;
  rangeHalfPct: number;
  gridCount: number;
  sizeBase: number;
  leverage: number;
  skipBand: number;
  autoStopOutOfRange: boolean;
  autoRecenter: boolean;
  recenterCooldownMs: number;
  price: number;
  spacingPct: number;
  perRungUsd: number;
  /** 每单名义 USD（Ondo 等） */
  orderNotionalUsd?: number;
  /** 每格利润 USD（走完一格间距） */
  perRungProfitUsd?: number;
  estMarginUsd: number;
  sliceUsd: number;
}

export function gridParamsForSymbol(symbol: string): { leverage: number; gridCount: number } {
  const s = symbol.toUpperCase();
  if (DEC_CRYPTO_POOL.has(s)) return { leverage: DEC_CRYPTO_GRID.leverage, gridCount: DEC_CRYPTO_GRID.gridCount };
  if (["NVDA", "TSLA", "AMZN", "GOOGL"].includes(s)) return { leverage: 3, gridCount: 10 };
  return { leverage: 5, gridCount: 12 };
}

export function rangeHalfFromAtr(atrPct: number, profile?: FleetVenueProfile): number {
  const d = profile?.defaults ?? FLEET_DEFAULTS;
  const atr = Number(atrPct) || 1;
  const half = (atr / 100) * d.RANGE_ATR_MULT;
  return Math.min(d.RANGE_MAX_HALF_PCT, Math.max(d.RANGE_MIN_HALF_PCT, half));
}

function floorStep(val: number, step: number): number {
  const s = Number(step) || 0.0001;
  if (!s) return val;
  return Math.floor(val / s) * s;
}

function priceBand(price: number, halfPct: number) {
  return {
    lower: +(price * (1 - halfPct)).toFixed(2),
    upper: +(price * (1 + halfPct)).toFixed(2),
  };
}

export function buildPlanFromSelection(params: {
  balance: number;
  markets: GridMarket[];
  sel: FleetSelection & { weight: number };
  profile?: FleetVenueProfile;
}): FleetPlanItem {
  const { balance, markets, profile } = params;
  const d = profile?.defaults ?? FLEET_DEFAULTS;
  const gpFn = profile?.gridParams ?? gridParamsForSymbol;
  let sel = params.sel;
  const m = markets.find((x) => x.marketId === sel.marketId);
  if (!m?.lastPrice) throw new Error(`市场 ${sel.name} 不可用`);

  if (profile?.id === "ondo") {
    const atrPct = (sel.analysis as { atrPct?: number | null } | undefined)?.atrPct ?? null;
    const measured = measureOndoGridParams({
      balance,
      slotCount: Math.max(1, Math.round(1 / sel.weight)),
      price: m.lastPrice,
      atrPct,
      minOrderSize: m.minOrderSize || m.stepSize || 0.01,
      stepSize: m.stepSize || 0.01,
      budgetUse: d.BUDGET_USE,
      leverage: sel.leverage ?? gpFn(m.symbol).leverage,
      rangeHalfPct: sel.rangeHalfPct,
    });
    if (!measured.feasible) {
      throw new Error(`${sel.name} ${measured.note ?? "网格不可行"}`);
    }
    sel = {
      ...sel,
      gridCount: measured.gridCount,
      leverage: measured.leverage,
      rangeHalfPct: measured.rangeHalfPct,
    };

    const price = m.lastPrice;
    const halfPct = sel.rangeHalfPct ?? d.RANGE_MIN_HALF_PCT;
    const leverage = sel.leverage ?? gpFn(m.symbol).leverage;
    const gridCount = sel.gridCount ?? gpFn(m.symbol).gridCount;
    const sizeBase = measured.sizeBase;
    const { lower, upper } = priceBand(price, halfPct);
    const mid = (lower + upper) / 2;
    const spacing = (upper - lower) / gridCount;
    const estMargin = (gridCount * sizeBase * mid) / leverage;

    return {
      marketId: m.marketId,
      name: sel.name,
      symbol: m.symbol,
      weight: sel.weight,
      score: sel.score,
      mode: "neutral",
      lower,
      upper,
      rangeHalfPct: halfPct,
      gridCount,
      sizeBase: +sizeBase.toFixed(8),
      leverage,
      skipBand: d.SKIP_BAND,
      autoStopOutOfRange: d.AUTO_STOP_OUT_OF_RANGE,
      autoRecenter: d.AUTO_RECENTER,
      recenterCooldownMs: d.RECENTER_COOLDOWN_MS,
      price: +price.toFixed(2),
      spacingPct: +((spacing / price) * 100).toFixed(2),
      perRungUsd: measured.perRungProfitUsd,
      orderNotionalUsd: measured.orderNotionalUsd,
      perRungProfitUsd: measured.perRungProfitUsd,
      estMarginUsd: +estMargin.toFixed(1),
      sliceUsd: +(balance * sel.weight).toFixed(2),
    };
  }

  const price = m.lastPrice;
  const halfPct = sel.rangeHalfPct ?? d.RANGE_MIN_HALF_PCT;
  const leverage = sel.leverage ?? gpFn(m.symbol).leverage;
  const gridCount = sel.gridCount ?? gpFn(m.symbol).gridCount;
  const weight = sel.weight;
  const step = m.stepSize || m.minOrderSize || 0.0001;
  const minSz = m.minOrderSize || step;

  const slice = balance * weight;
  const notional = slice * leverage * d.BUDGET_USE;
  let sizeBase = floorStep(notional / gridCount / price, step);
  if (sizeBase < minSz) sizeBase = minSz;

  const maxRungUsd = (notional / gridCount) * 1.8;
  const orderUsd = sizeBase * price;
  const sliceCapFrac = gridCount <= 10 ? 0.38 : gridCount <= 14 ? 0.34 : 0.32;
  if (orderUsd > maxRungUsd || orderUsd > slice * sliceCapFrac) {
    throw new Error(`${sel.name} 单格名义过大（~${orderUsd.toFixed(1)}U）`);
  }

  const { lower, upper } = priceBand(price, halfPct);
  const mid = (lower + upper) / 2;
  const spacing = (upper - lower) / gridCount;
  const estMargin = (gridCount * sizeBase * mid) / leverage;

  return {
    marketId: m.marketId,
    name: sel.name,
    symbol: m.symbol,
    weight,
    score: sel.score,
    mode: "neutral",
    lower,
    upper,
    rangeHalfPct: halfPct,
    gridCount,
    sizeBase: +sizeBase.toFixed(8),
    leverage,
    skipBand: d.SKIP_BAND,
    autoStopOutOfRange: d.AUTO_STOP_OUT_OF_RANGE,
    autoRecenter: d.AUTO_RECENTER,
    recenterCooldownMs: d.RECENTER_COOLDOWN_MS,
    price: +price.toFixed(2),
    spacingPct: +((spacing / price) * 100).toFixed(2),
    perRungUsd: +(spacing * sizeBase).toFixed(3),
    estMarginUsd: +estMargin.toFixed(1),
    sliceUsd: +slice.toFixed(2),
  };
}

export function planToBotConfig(plan: FleetPlanItem) {
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
    onBreakRange: "shiftGrid" as const,
    nearSeedRatio: 1,
  };
}

export function buildFleetPlans(params: {
  balance: number;
  markets: GridMarket[];
  selections: FleetSelection[];
  profile?: FleetVenueProfile;
}): {
  balance: number;
  totalEstMarginUsd: number;
  marginBufferUsd: number;
  activeSlots: number;
  candidatePool: string[];
  plans: FleetPlanItem[];
} {
  const { balance, markets, selections } = params;
  if (!(balance > 0)) throw new Error("无效余额");
  if (!selections.length) throw new Error("无可用标的");

  const plans = selections.map((sel) =>
    buildPlanFromSelection({
      balance,
      markets,
      sel: { ...sel, weight: sel.weight ?? 1 / selections.length },
      profile: params.profile,
    })
  );
  const totalMargin = plans.reduce((a, p) => a + p.estMarginUsd, 0);

  return {
    balance: +balance.toFixed(2),
    totalEstMarginUsd: +totalMargin.toFixed(1),
    marginBufferUsd: +(balance - totalMargin).toFixed(1),
    activeSlots: selections.length,
    candidatePool: selections.map((s) => s.symbol),
    plans,
  };
}

/** @deprecated 固定列表选标（仅 fallback） */
export function buildFleetPlansFromSymbols(params: {
  balance: number;
  markets: GridMarket[];
  symbols: string[];
  slots: number;
}) {
  const picked: GridMarket[] = [];
  for (const sym of params.symbols) {
    const m = params.markets.find((x) => x.symbol.toUpperCase() === sym.toUpperCase());
    if (m?.lastPrice) picked.push(m);
    if (picked.length >= params.slots) break;
  }
  if (!picked.length) throw new Error("无可用标的");
  const selections: FleetSelection[] = picked.map((m) => ({
    marketId: m.marketId,
    name: m.displayName,
    symbol: m.symbol,
    score: 0,
    rangeHalfPct: FLEET_DEFAULTS.RANGE_MIN_HALF_PCT,
    leverage: gridParamsForSymbol(m.symbol).leverage,
    gridCount: gridParamsForSymbol(m.symbol).gridCount,
    weight: 1 / picked.length,
  }));
  return buildFleetPlans({ balance: params.balance, markets: params.markets, selections });
}
