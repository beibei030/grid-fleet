/** 看板 livePositions 行（对齐 extended-grid） */
export interface GridLivePosition {
  market: string;
  marketId: number;
  side: "long" | "short";
  size: number;
  sizeBase: number;
  entryPrice: number;
  markPrice: number;
  valueUsd: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  leverage: number | null;
  margin?: number | null;
  liquidationPrice?: number | null;
  inFleet?: boolean;
}

export interface GridOfficialStats {
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  totalPnl: number | null;
  pnlSource: string;
  feesPaid: number | null;
  volume?: number | null;
  /** 官方 fills 笔数（与官网成交历史同源） */
  tradeCount?: number | null;
  /** 成交量数据来源说明 */
  volumeSource?: string | null;
  /** 成交量统计时间窗，如「近30日」 */
  statsWindow?: string | null;
  byMarket: Record<string, { realizedPnl?: number; fees?: number }>;
  allClosed: { market: string; closedTime?: number; realizedPnl?: number }[];
  recentClosed: { market: string; closedTime?: number; realizedPnl?: number }[];
  updatedAt: number;
}

export interface GridAdapterExtras {
  dataSource?: string;
  network?: string;
  getAllPositions?: () => GridLivePosition[];
  getOfficialStats?: () => GridOfficialStats | null;
  getAllOpenOrdersLive?: () => Promise<
    {
      orderId: string;
      marketId: number;
      symbol?: string;
      side: "buy" | "sell";
      price: number;
      sizeBase: number;
      levelIndex?: number;
    }[]
  >;
  cancelUnmanagedOrders?: (managedIds: Set<string>, runningMarketIds: number[], allowedSymbols: string[]) => Promise<number>;
}
