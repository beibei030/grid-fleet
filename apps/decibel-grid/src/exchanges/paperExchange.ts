import { priceFeed, SYMBOLS } from "./priceFeed.js";
import type {
  AccountStats,
  Balance,
  ExchangeAdapter,
  MarketInfo,
  OrderResult,
  PlaceOrderParams,
  Position,
  Side,
} from "./types.js";
import { log } from "../util/logger.js";

interface PaperPos {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  fundingPaid: number;
  leverage: number;
  lastFundingTs: number;
}

export interface PaperOptions {
  name: string;
  startEquity: number;
  takerFee: number; // 小数
  /** 相对公允价的基差（小数），模拟跨所价差 */
  basis: number;
  /** 每个 symbol 的 8h 资金费率倍率/偏移，模拟两所资金费差异 */
  fundingBias: number;
}

export class PaperExchange implements ExchangeAdapter {
  readonly name: string;
  private opts: PaperOptions;
  private cashPnl = 0; // 已实现盈亏 + 手续费 + 资金费
  private startEquity: number;
  private positions = new Map<string, PaperPos>();
  private fundingRates = new Map<string, number>();
  private fundingDriftTs = Date.now();

  constructor(opts: PaperOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.startEquity = opts.startEquity;
    for (const s of SYMBOLS) {
      // 初始资金费率：围绕一个小数随机，叠加该交易所偏置
      const base = (Math.random() - 0.4) * 0.0006;
      this.fundingRates.set(s.symbol, base + opts.fundingBias);
    }
  }

  async init() {
    priceFeed.start();
    log.info(`[${this.name}] paper exchange ready, equity=$${this.startEquity}`);
  }

  private fair(symbol: string): number {
    return priceFeed.getPrice(symbol) * (1 + this.opts.basis);
  }

  private driftFunding() {
    const now = Date.now();
    if (now - this.fundingDriftTs < 8000) return;
    this.fundingDriftTs = now;
    for (const [sym, r] of this.fundingRates) {
      const next = r + (Math.random() - 0.5) * 0.0001;
      // 限制在合理范围
      this.fundingRates.set(sym, Math.max(-0.002, Math.min(0.002, next)));
    }
  }

  private accrueFunding(p: PaperPos) {
    const now = Date.now();
    const dt = now - p.lastFundingTs;
    if (dt <= 0) return;
    p.lastFundingTs = now;
    const rate8h = this.fundingRates.get(p.symbol) ?? 0;
    const notional = p.size * this.fair(p.symbol);
    // 多头付资金费(正费率时)，空头收
    const sign = p.side === "long" ? -1 : 1;
    const pay = sign * rate8h * notional * (dt / (8 * 3600 * 1000));
    p.fundingPaid += pay;
    this.cashPnl += pay;
  }

  async getBalance(): Promise<Balance> {
    this.driftFunding();
    let upnl = 0;
    let usedMargin = 0;
    for (const p of this.positions.values()) {
      this.accrueFunding(p);
      const mark = this.fair(p.symbol);
      const dir = p.side === "long" ? 1 : -1;
      upnl += (mark - p.entryPrice) * p.size * dir;
      usedMargin += (p.size * p.entryPrice) / p.leverage;
    }
    const equity = this.startEquity + this.cashPnl + upnl;
    return { equity, available: Math.max(0, equity - usedMargin) };
  }

  async getAccountStats(): Promise<AccountStats> {
    this.driftFunding();
    let upnl = 0;
    let usedMargin = 0;
    for (const p of this.positions.values()) {
      this.accrueFunding(p);
      const mark = this.fair(p.symbol);
      const dir = p.side === "long" ? 1 : -1;
      upnl += (mark - p.entryPrice) * p.size * dir;
      usedMargin += (p.size * p.entryPrice) / p.leverage;
    }
    const equity = this.startEquity + this.cashPnl + upnl;
    return {
      equity,
      available: Math.max(0, equity - usedMargin),
      unrealizedPnl: upnl,
      realizedPnl: this.cashPnl,
    };
  }

  async getMarkets(): Promise<MarketInfo[]> {
    this.driftFunding();
    return SYMBOLS.map((s) => this.toMarket(s.symbol)!);
  }

  async getMarket(symbol: string): Promise<MarketInfo | undefined> {
    return this.toMarket(symbol);
  }

  private toMarket(symbol: string): MarketInfo | undefined {
    const spec = priceFeed.getSpec(symbol);
    if (!spec) return undefined;
    return {
      symbol,
      maxLeverage: spec.maxLeverage,
      fundingRate8h: this.fundingRates.get(symbol) ?? 0,
      markPrice: this.fair(symbol),
      minOrderSize: spec.minOrderSize,
      lotSize: spec.lotSize,
      tickSize: spec.tickSize,
    };
  }

  async getPositions(): Promise<Position[]> {
    const out: Position[] = [];
    for (const p of this.positions.values()) {
      this.accrueFunding(p);
      const mark = this.fair(p.symbol);
      const dir = p.side === "long" ? 1 : -1;
      const upnl = (mark - p.entryPrice) * p.size * dir;
      out.push({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: mark,
        liqPrice: this.estLiqPrice(p),
        unrealizedPnl: upnl,
        fundingPaid: p.fundingPaid,
      });
    }
    return out;
  }

  private estLiqPrice(p: PaperPos): number {
    // 简化估算：维持保证金率 0.5%
    const mmr = 0.005;
    const dir = p.side === "long" ? 1 : -1;
    return p.entryPrice * (1 - dir * (1 / p.leverage - mmr));
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const p = this.positions.get(symbol);
    if (p) p.leverage = leverage;
  }

  async placeMarketOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const { symbol, side, size, reduceOnly } = params;
    const spec = priceFeed.getSpec(symbol);
    if (!spec) return { ok: false, error: `unknown symbol ${symbol}` };
    if (size < spec.minOrderSize) return { ok: false, error: `size<min(${spec.minOrderSize})` };

    // 市价单滑点：1bp
    const mark = this.fair(symbol);
    const slip = side === "long" ? 1.0001 : 0.9999;
    const fill = mark * slip;
    const notional = size * fill;
    const fee = notional * this.opts.takerFee;
    this.cashPnl -= fee;

    const existing = this.positions.get(symbol);
    if (reduceOnly || (existing && existing.side !== side)) {
      // 平仓/减仓逻辑
      if (!existing) return { ok: true, filledSize: 0, avgPrice: fill, fee };
      const closeSize = Math.min(size, existing.size);
      const dir = existing.side === "long" ? 1 : -1;
      const realized = (fill - existing.entryPrice) * closeSize * dir;
      this.cashPnl += realized;
      existing.size -= closeSize;
      if (existing.size <= spec.lotSize / 2) this.positions.delete(symbol);
      return { ok: true, orderId: id(), filledSize: closeSize, avgPrice: fill, fee };
    }

    // 开/加仓
    if (existing) {
      const total = existing.size + size;
      existing.entryPrice = (existing.entryPrice * existing.size + fill * size) / total;
      existing.size = total;
    } else {
      this.positions.set(symbol, {
        symbol,
        side,
        size,
        entryPrice: fill,
        fundingPaid: 0,
        leverage: 5,
        lastFundingTs: Date.now(),
      });
    }
    return { ok: true, orderId: id(), filledSize: size, avgPrice: fill, fee };
  }

  async closePosition(symbol: string): Promise<OrderResult> {
    const p = this.positions.get(symbol);
    if (!p) return { ok: false, error: "NO_POSITION_SEEN", filledSize: 0 };
    return this.placeMarketOrder({
      symbol,
      side: p.side === "long" ? "short" : "long",
      size: p.size,
      reduceOnly: true,
    });
  }
}

function id() {
  return Math.random().toString(36).slice(2, 10);
}
