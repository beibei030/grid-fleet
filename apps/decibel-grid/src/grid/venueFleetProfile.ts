import { FLEET_DEFAULTS, DEC_CRYPTO_GRID, DEC_CRYPTO_POOL, type FleetSelection } from "./fleetPlan.js";

/** 各交易所网格舰队参数（Dec / Ondo 与 Extended 加密逻辑分离） */
export interface FleetVenueProfile {
  id: "dec" | "ondo" | "default";
  label: string;
  defaults: typeof FLEET_DEFAULTS & {
    /** 选标最低得分（维持槽位） */
    MIN_KEEP_SCORE?: number;
    /** 扫描缓存毫秒 */
    SCORE_CACHE_MS?: number;
  };
  gridParams: (symbol: string) => { leverage: number; gridCount: number };
  /** post-only 限价相对网格价偏移 tick 数（避免 RWA 盘口吃单拒单） */
  postOnlyTickOffset: number;
  /** 优先标的加分 */
  preferBonus: number;
  /** 震荡偏好：ATR 理想区间（%） */
  idealAtrPct: [number, number];
}

const DEC_PROFILE: FleetVenueProfile = {
  id: "dec",
  label: "Decibel",
  defaults: {
    ...FLEET_DEFAULTS,
    MIN_KEEP_SCORE: 12,
    SCORE_CACHE_MS: 3_600_000,
    RANGE_MIN_HALF_PCT: DEC_CRYPTO_GRID.rangeHalfPct,
    RANGE_MAX_HALF_PCT: DEC_CRYPTO_GRID.rangeHalfPct,
  },
  gridParams(symbol) {
    const s = symbol.toUpperCase();
    if (DEC_CRYPTO_POOL.has(s)) {
      return { leverage: DEC_CRYPTO_GRID.leverage, gridCount: DEC_CRYPTO_GRID.gridCount };
    }
    return { leverage: 5, gridCount: 12 };
  },
  postOnlyTickOffset: 1,
  preferBonus: 12,
  idealAtrPct: [0.35, 4],
};

/** Ondo = 代币化美股永续：24h、波动低于 crypto、min lot 约束 */
export const ONDO_FLEET_PROFILE: FleetVenueProfile = {
  id: "ondo",
  label: "Ondo 代币股",
  defaults: {
    ...FLEET_DEFAULTS,
    BUDGET_USE: 0.35,
    SKIP_BAND: 0.15,
    RANGE_MIN_HALF_PCT: 0.03,
    RANGE_MAX_HALF_PCT: 0.05,
    RANGE_ATR_MULT: 1.15,
    RECENTER_COOLDOWN_MS: 60 * 60 * 1000,
    ROTATION_CHECK_MS: 60 * 60 * 1000,
    STOPPED_REPLACE_MS: 3 * 60 * 60 * 1000,
    MIN_KEEP_SCORE: 14,
    SCORE_CACHE_MS: 60 * 60 * 1000,
  },
  gridParams(_symbol) {
    return { leverage: 5, gridCount: 6 };
  },
  postOnlyTickOffset: 2,
  preferBonus: 15,
  idealAtrPct: [0.55, 2.4],
};

const DEFAULT_PROFILE = DEC_PROFILE;

export function getVenueFleetProfile(venue: string): FleetVenueProfile {
  if (venue === "ondo") return ONDO_FLEET_PROFILE;
  if (venue === "dec") return DEC_PROFILE;
  return DEFAULT_PROFILE;
}

export function mergeVenueProfileFromEnv(base: FleetVenueProfile, env: {
  budgetUse?: number;
  rangeMinHalfPct?: number;
  rangeMaxHalfPct?: number;
  leverage?: number;
  gridCount?: number;
  postOnlyTickOffset?: number;
  skipBand?: number;
}): FleetVenueProfile {
  const p = { ...base, defaults: { ...base.defaults } };
  if (env.budgetUse != null && env.budgetUse > 0) p.defaults.BUDGET_USE = env.budgetUse;
  if (env.rangeMinHalfPct != null && env.rangeMinHalfPct > 0) p.defaults.RANGE_MIN_HALF_PCT = env.rangeMinHalfPct;
  if (env.rangeMaxHalfPct != null && env.rangeMaxHalfPct > 0) p.defaults.RANGE_MAX_HALF_PCT = env.rangeMaxHalfPct;
  if (env.skipBand != null && env.skipBand > 0) p.defaults.SKIP_BAND = env.skipBand;
  if (env.postOnlyTickOffset != null && env.postOnlyTickOffset >= 0) p.postOnlyTickOffset = env.postOnlyTickOffset;
  if ((env.leverage != null && env.leverage > 0) || (env.gridCount != null && env.gridCount > 0)) {
    const lev = env.leverage;
    const gc = env.gridCount;
    const prev = p.gridParams;
    p.gridParams = (sym) => {
      const x = prev(sym);
      return { leverage: lev && lev > 0 ? lev : x.leverage, gridCount: gc && gc > 0 ? gc : x.gridCount };
    };
  }
  return p;
}

/** @deprecated use mergeVenueProfileFromEnv */
export const mergeOndoProfileFromEnv = mergeVenueProfileFromEnv;
