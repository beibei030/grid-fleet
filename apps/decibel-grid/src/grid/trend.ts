import { atr, ema, normalizedSlope } from "./indicators.js";

export interface GridCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export function analyzeTrend(candles: GridCandle[], opts: { fast?: number; slow?: number; slopeBars?: number; slopeThreshold?: number } = {}) {
  const fast = opts.fast ?? 20;
  const slow = opts.slow ?? 50;
  const slopeBars = opts.slopeBars ?? 20;
  const slopeThreshold = opts.slopeThreshold ?? 0.0015;

  const closes = candles.map((c) => c.close).filter((v) => Number.isFinite(v));
  const price = closes[closes.length - 1];

  if (closes.length < slow + 1) {
    return {
      trend: "range" as const,
      recommended: "neutral" as const,
      strength: 0,
      atrPct: null as number | null,
      price,
      detail: `K线样本不足（需要至少 ${slow + 1} 根，当前 ${closes.length} 根），默认中性网格。`,
    };
  }

  const emaFast = ema(closes, fast)!;
  const emaSlow = ema(closes, slow)!;
  const slope = normalizedSlope(closes, slopeBars);
  const a = atr(candles, 14);
  const atrPct = a && price ? (a / price) * 100 : null;
  const emaGapPct = ((emaFast - emaSlow) / emaSlow) * 100;
  const up = emaFast > emaSlow && slope > slopeThreshold;
  const down = emaFast < emaSlow && slope < -slopeThreshold;
  const strength = Math.min(
    1,
    (Math.abs(slope) / (slopeThreshold * 4)) * 0.6 + (Math.abs(emaGapPct) / 3) * 0.4
  );

  let trend: "up" | "down" | "range";
  let recommended: "long" | "short" | "neutral";
  let detail: string;
  if (up) {
    trend = "up";
    recommended = "long";
    detail = `上升趋势：EMA${fast} 在 EMA${slow} 之上（差 ${emaGapPct.toFixed(2)}%），斜率 +${(slope * 100).toFixed(3)}%/根。推荐做多网格。`;
  } else if (down) {
    trend = "down";
    recommended = "short";
    detail = `下降趋势：EMA${fast} 在 EMA${slow} 之下（差 ${emaGapPct.toFixed(2)}%），斜率 ${(slope * 100).toFixed(3)}%/根。推荐做空网格。`;
  } else {
    trend = "range";
    recommended = "neutral";
    detail = `震荡/无明显趋势：EMA 差 ${emaGapPct.toFixed(2)}%，斜率 ${(slope * 100).toFixed(3)}%/根。推荐中性网格。`;
  }

  const volNote =
    atrPct != null ? ` 波动率 ATR≈${atrPct.toFixed(2)}%，建议单格间距不小于该值的一半以覆盖手续费。` : "";

  return {
    trend,
    recommended,
    strength: Number(strength.toFixed(2)),
    atrPct: atrPct != null ? Number(atrPct.toFixed(3)) : null,
    price,
    emaFast,
    emaSlow,
    slopePct: Number((slope * 100).toFixed(4)),
    detail: detail + volNote,
  };
}
