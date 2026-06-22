import { EventEmitter } from "node:events";

export interface GridMarket {
  marketId: number;
  displayName: string;
  symbol: string;
  lastPrice: number;
  stepSize: number;
  stepPrice: number;
  maxLeverage: number;
  minOrderSize: number;
}

export interface GridOrder {
  orderId: string;
  marketId: number;
  side: "buy" | "sell";
  price: number;
  sizeBase: number;
  reduceOnly: boolean;
  levelIndex?: number;
  clientOrderId?: string;
}

export interface GridFill {
  orderId: string;
  marketId: number;
  side: "buy" | "sell";
  price: number;
  sizeBase: number;
  levelIndex?: number;
  clientOrderId?: string;
}

export interface GridPosition {
  sizeBase: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage?: number;
}

/** GridBot 所需的交易所契约（EventEmitter + 轮询成交） */
export abstract class GridExchangeAdapter extends EventEmitter {
  abstract readonly mode: string;
  balance: number | null = null;
  equity: number | null = null;
  unrealisedPnl: number | null = null;

  abstract init(): Promise<void>;
  abstract getMarkets(): Promise<GridMarket[]>;
  abstract getCandles(marketId: number, intervalSec: number, n: number): Promise<import("./trend.js").GridCandle[]>;
  abstract getPrice(marketId: number): Promise<number>;
  abstract setLeverage(marketId: number, leverage: number): Promise<void>;
  abstract placeLimitOrder(o: {
    marketId: number;
    side: "buy" | "sell";
    price: number;
    sizeBase: number;
    reduceOnly?: boolean;
    levelIndex?: number;
    clientOrderId?: number;
  }): Promise<{ orderId: string } | null>;
  abstract cancelOrder(marketId: number, orderId: string): Promise<void>;
  abstract cancelAll(marketId: number): Promise<void>;
  abstract getOpenOrders(marketId: number): GridOrder[];
  abstract getPosition(marketId: number): GridPosition | null;
  abstract closePosition(marketId: number): Promise<boolean>;
  abstract start(): void;
  abstract stop(): void;
}
