/** 等差网格纯函数（来自 extended-grid/grid.js） */

export type GridMode = "neutral" | "long" | "short";

export interface GridSpec {
  levels: number[];
  spacing: number;
  count: number;
}

export interface SeedOrder {
  levelIndex: number;
  price: number;
  side: "buy" | "sell";
  reduceOnly: boolean;
}

export function buildGrid(params: { lower: number; upper: number; gridCount: number }): GridSpec {
  const { lower, upper, gridCount } = params;
  if (!(upper > lower)) throw new Error("upper 必须大于 lower");
  if (!(gridCount >= 2)) throw new Error("gridCount 至少为 2");
  const spacing = (upper - lower) / gridCount;
  const levels: number[] = [];
  for (let i = 0; i <= gridCount; i++) levels.push(round(lower + i * spacing));
  return { levels, spacing: round(spacing), count: gridCount };
}

export function isReduceOnly(side: "buy" | "sell", mode: GridMode): boolean {
  if (mode === "long") return side === "sell";
  if (mode === "short") return side === "buy";
  return false;
}

/** 中性网格：按持仓方向决定 reduce-only（多头卖平、空头买平） */
export function resolveReduceOnly(
  side: "buy" | "sell",
  mode: GridMode,
  positionSizeBase: number,
  eps = 1e-9
): boolean {
  if (mode === "long") return side === "sell";
  if (mode === "short") return side === "buy";
  if (positionSizeBase > eps) return side === "sell";
  if (positionSizeBase < -eps) return side === "buy";
  return false;
}

/** 是否允许该侧开仓（加仓方向）；平仓侧始终允许 */
export function shouldAllowOpenSide(
  side: "buy" | "sell",
  mode: GridMode,
  positionSizeBase: number,
  sizeBase: number,
  maxInventoryMult = 4
): boolean {
  const max = sizeBase * maxInventoryMult;
  if (resolveReduceOnly(side, mode, positionSizeBase)) return true;
  if (mode === "long") return side === "buy" && positionSizeBase < max;
  if (mode === "short") return side === "sell" && positionSizeBase > -max;
  if (side === "buy") return positionSizeBase < max;
  return positionSizeBase > -max;
}

/** 成交是否完成一格（兑现利润方向） */
export function isClosingFill(
  side: "buy" | "sell",
  mode: GridMode,
  positionSizeBaseBefore: number,
  eps = 1e-9
): boolean {
  if (mode === "long") return side === "sell";
  if (mode === "short") return side === "buy";
  if (positionSizeBaseBefore > eps) return side === "sell";
  if (positionSizeBaseBefore < -eps) return side === "buy";
  return false;
}

export const CLOSE_COVER_RATIO = 0.7;

export function seedOrders(params: {
  levels: number[];
  price: number;
  mode: GridMode;
  skipBand?: number;
  spacing?: number;
}): SeedOrder[] {
  const { levels, price, mode, skipBand = 0.25, spacing } = params;
  const band = (spacing ?? gridSpacing(levels)) * skipBand;
  const orders: SeedOrder[] = [];
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    if (Math.abs(lvl - price) < band) continue;
    if (lvl < price) {
      if (mode === "neutral" || mode === "long") {
        orders.push({ levelIndex: i, price: lvl, side: "buy", reduceOnly: isReduceOnly("buy", mode) });
      }
    } else if (lvl > price) {
      if (mode === "neutral" || mode === "short") {
        orders.push({ levelIndex: i, price: lvl, side: "sell", reduceOnly: isReduceOnly("sell", mode) });
      }
    }
  }
  return orders;
}

export function replacementFor(
  filled: { side: "buy" | "sell"; levelIndex: number },
  levels: number[],
  mode: GridMode
): SeedOrder | null {
  if (filled.side === "buy") {
    const j = filled.levelIndex + 1;
    if (j > levels.length - 1) return null;
    return { levelIndex: j, price: levels[j], side: "sell", reduceOnly: isReduceOnly("sell", mode) };
  }
  const j = filled.levelIndex - 1;
  if (j < 0) return null;
  return { levelIndex: j, price: levels[j], side: "buy", reduceOnly: isReduceOnly("buy", mode) };
}

export function rungProfit(spacing: number, sizeBase: number): number {
  return spacing * sizeBase;
}

function gridSpacing(levels: number[]): number {
  return levels.length > 1 ? levels[1] - levels[0] : 0;
}

function round(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}
