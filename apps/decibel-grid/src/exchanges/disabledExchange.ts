import type {
  AccountStats,
  Balance,
  ExchangeAdapter,
  MarketInfo,
  OrderResult,
  PlaceOrderParams,
  Position,
} from "./types.js";

/** 未配置凭证时的占位适配器（不参与交易，不阻塞启动）。 */
export class DisabledExchange implements ExchangeAdapter {
  readonly name: string;
  readonly reason: string;

  constructor(name: string, reason: string) {
    this.name = name;
    this.reason = reason;
  }

  async init(): Promise<void> {}

  async getBalance(): Promise<Balance> {
    return { equity: 0, available: 0 };
  }

  async getAccountStats(): Promise<AccountStats> {
    return { equity: 0, available: 0, unrealizedPnl: 0, statsWindow: "未配置" };
  }

  async getMarkets(): Promise<MarketInfo[]> {
    return [];
  }

  async getMarket(_symbol: string): Promise<MarketInfo | undefined> {
    return undefined;
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async setLeverage(_symbol: string, _leverage: number): Promise<void> {}

  async placeMarketOrder(_p: PlaceOrderParams): Promise<OrderResult> {
    return { ok: false, error: this.reason };
  }

  async closePosition(_symbol: string): Promise<OrderResult> {
    return { ok: false, error: this.reason };
  }
}
