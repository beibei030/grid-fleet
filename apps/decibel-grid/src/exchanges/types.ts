export type Side = "long" | "short";

export interface MarketInfo {
  symbol: string;
  maxLeverage: number;
  /** 8 小时资金费率，小数表示。正值表示多头付空头。 */
  fundingRate8h: number;
  markPrice: number;
  minOrderSize: number;
  lotSize: number;
  tickSize: number;
}

export interface Balance {
  /** 账户权益（含浮盈） */
  equity: number;
  /** 可用保证金 */
  available: number;
}

/** 交易所口径的真实账户统计（用于面板与官网对齐） */
export interface AccountStats {
  equity: number;
  available: number;
  /** 未实现盈亏（交易所口径） */
  unrealizedPnl: number;
  /** 已实现盈亏（交易所口径，可能为窗口/全时口径），不可得为 undefined */
  realizedPnl?: number;
  /** 手续费（交易所口径），不可得为 undefined */
  feesPaid?: number;
  /** 交易量（交易所口径，如近 30 天），不可得为 undefined */
  volume?: number;
  /** 总盈亏（交易所口径 totalPnL），不可得为 undefined */
  totalPnl?: number;
  /** 统计时间窗说明（展示用） */
  statsWindow?: string;
}

export interface Position {
  symbol: string;
  side: Side;
  /** 基础币数量（绝对值） */
  size: number;
  entryPrice: number;
  markPrice: number;
  liqPrice: number;
  unrealizedPnl: number;
  /** 累计资金费（正=收到） */
  fundingPaid: number;
  /** 开仓后已实现项（交易所口径，可能包含手续费/资金费；不可得为 undefined） */
  realizedPnl?: number;
}

export interface OrderResult {
  ok: boolean;
  orderId?: string;
  filledSize?: number;
  avgPrice?: number;
  /** 本次成交手续费（USD） */
  fee?: number;
  error?: string;
  /** 开仓单：原生 TP/SL 是否已成功挂上 */
  nativeTpslPlaced?: boolean;
}

/** 单笔对冲在交易所成交明细中汇总出的盈亏（交易所口径） */
export interface HedgeTradeSettlement {
  realizedPnl: number;
  fees: number;
  volume: number;
  tradeCount: number;
}

export interface HedgeSettlementQuery {
  id: string;
  symbol: string;
  openedAt: number;
  closedAt?: number;
  longLeg: { exchange: string; side: Side };
  shortLeg: { exchange: string; side: Side };
}

export interface PlaceOrderParams {
  symbol: string;
  side: Side;
  /** 基础币数量 */
  size: number;
  reduceOnly?: boolean;
  clientId?: string;
  /** 可选：交易所原生止损触发价。仅开仓单有效。 */
  stopLossTriggerPrice?: number;
  /** 可选：交易所原生止盈触发价。仅开仓单有效。 */
  takeProfitTriggerPrice?: number;
  /** 可选：用 maker(post-only)限价挂单代替市价吃单（更省费，可能不成交）。 */
  maker?: boolean;
  /** maker 未成交时是否回退 taker；网格盈利模式应设 false */
  takerFallback?: boolean;
}

export interface OpenOrderView {
  orderId: string;
  clientId: string;
  symbol: string;
  price: number;
  size: number;
  isBuy: boolean;
  reduceOnly: boolean;
}

/**
 * 统一交易所接口。Paper / Decibel / Extended 都实现它，
 * 上层（对冲管理器、风控）只依赖这个抽象，互不耦合。
 */
export interface ExchangeAdapter {
  readonly name: string;
  init(): Promise<void>;
  getBalance(): Promise<Balance>;
  /** 交易所口径真实账户统计 */
  getAccountStats(): Promise<AccountStats>;
  getMarkets(): Promise<MarketInfo[]>;
  getMarket(symbol: string): Promise<MarketInfo | undefined>;
  getPositions(): Promise<Position[]>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeMarketOrder(p: PlaceOrderParams): Promise<OrderResult>;
  /** 以 reduceOnly 市价单平掉指定 symbol 的全部仓位 */
  closePosition(symbol: string): Promise<OrderResult>;
  /** 从交易所成交/持仓历史汇总本笔对冲盈亏（paper 返回 null） */
  fetchHedgeTradeSettlement?(
    hedge: HedgeSettlementQuery,
    legSide?: Side
  ): Promise<HedgeTradeSettlement | null>;
  /** 按 clientId 前缀拉取时间窗内成交汇总（Harvest 单腿平仓结算） */
  fetchClientFillsSince?(
    symbol: string,
    sinceMs: number,
    clientIdPrefix: string
  ): Promise<HedgeTradeSettlement | null>;
}

/** 交易所账本：单笔成交（已规范化） */
export interface NormalizedTrade {
  ts: number;
  symbol: string;
  fee: number;
  realizedPnl: number;
  volume: number;
}

export interface NormalizedClosedPosition {
  closedAt: number;
  symbol: string;
  realizedPnl: number;
}
