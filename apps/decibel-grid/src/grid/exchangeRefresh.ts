/** 监控/看板前强制从交易所 REST 拉最新持仓、挂单、余额（不依赖内存 poll 缓存） */
import type { GridExchangeAdapter } from "./iExchange.js";
import type { GridAdapterExtras } from "./gridLiveTypes.js";
import { log } from "../util/logger.js";

export interface ExchangeRefreshResult {
  ok: boolean;
  positionsAt: number;
  ordersAt: number;
  accountAt: number;
  openOrderCount: number;
  positionCount: number;
  errors: string[];
}

type Refreshable = GridExchangeAdapter &
  GridAdapterExtras & {
    refreshAllPositions?: () => Promise<void>;
    refreshAccount?: () => Promise<void>;
    _refreshAllPositions?: () => Promise<void>;
    _refreshAccount?: () => Promise<void>;
    fetchAllOpenOrders?: () => Promise<unknown[]>;
    _refreshAllOpenOrders?: () => Promise<void>;
    getAllOpenOrdersLive?: () => Promise<unknown[]>;
    getOfficialOpenOrdersUpdatedAt?: () => number;
    getCachedOpenOrders?: (marketId: number) => unknown[];
    getAllPositions?: () => unknown[];
  };

export async function forceExchangeRefresh(
  adapter: GridExchangeAdapter | null,
  label = ""
): Promise<ExchangeRefreshResult> {
  const ex = adapter as Refreshable | null;
  const errors: string[] = [];
  let positionsAt = 0;
  let ordersAt = 0;
  let accountAt = 0;
  let openOrderCount = 0;
  let positionCount = 0;

  if (!ex) {
    return { ok: false, positionsAt: 0, ordersAt: 0, accountAt: 0, openOrderCount: 0, positionCount: 0, errors: ["adapter null"] };
  }

  const refreshAccount = ex.refreshAccount ?? ex._refreshAccount;
  if (typeof refreshAccount === "function") {
    try {
      await refreshAccount.call(ex);
      accountAt = Date.now();
    } catch (e: unknown) {
      errors.push(`account: ${(e as Error)?.message ?? e}`);
    }
  }

  const refreshPositions = ex.refreshAllPositions ?? ex._refreshAllPositions;
  if (typeof refreshPositions === "function") {
    try {
      await refreshPositions.call(ex);
      positionsAt = Date.now();
      positionCount = ex.getAllPositions?.()?.length ?? 0;
    } catch (e: unknown) {
      errors.push(`positions: ${(e as Error)?.message ?? e}`);
    }
  }

  if (typeof ex.getAllOpenOrdersLive === "function") {
    try {
      const live = await ex.getAllOpenOrdersLive();
      ordersAt = Date.now();
      openOrderCount = live.length;
    } catch (e: unknown) {
      errors.push(`orders-live: ${(e as Error)?.message ?? e}`);
    }
  } else if (typeof ex.fetchAllOpenOrders === "function") {
    try {
      const live = await ex.fetchAllOpenOrders();
      ordersAt = Date.now();
      openOrderCount = live.length;
    } catch (e: unknown) {
      errors.push(`orders-fetch: ${(e as Error)?.message ?? e}`);
    }
  } else if (typeof ex._refreshAllOpenOrders === "function") {
    try {
      await ex._refreshAllOpenOrders.call(ex);
      ordersAt = Date.now();
      openOrderCount = ex.getOfficialOpenOrdersUpdatedAt?.() ? 1 : 0;
    } catch (e: unknown) {
      errors.push(`orders-refresh: ${(e as Error)?.message ?? e}`);
    }
  }

  if (errors.length) {
    log.warn(`[Grid/${label}] exchange refresh: ${errors.join("; ")}`);
  }

  return {
    ok: errors.length === 0,
    positionsAt,
    ordersAt,
    accountAt,
    openOrderCount,
    positionCount,
    errors,
  };
}
