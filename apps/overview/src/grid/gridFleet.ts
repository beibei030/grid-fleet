/** 各所 /api/state 返回结构的类型占位（overview 只读聚合用） */
export interface GridFleetState {
  exchange?: string;
  running?: boolean;
  botCount?: number;
  openOrders?: number;
  accountOpenOrders?: number;
  equity?: number | null;
  balance?: number | null;
  volume?: number;
  todayVolume?: number;
  gridProfit?: number;
  accountPnl?: number | null;
  totalPnl?: number | null;
  unrealizedPnl?: number;
  realizedPnl?: number | null;
  feesPaid?: number | null;
  paused?: boolean;
  bots?: unknown[];
  alerts?: Array<{ t?: number; message?: string; symbol?: string }>;
  fleetMeta?: Record<string, unknown>;
  fleetHealth?: Record<string, unknown>;
  official?: Record<string, unknown> | null;
  livePositions?: unknown[];
  [key: string]: unknown;
}
