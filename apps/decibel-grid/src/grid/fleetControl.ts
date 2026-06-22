import type { GridExchangeAdapter } from "./iExchange.js";
import type { GridFleet } from "./gridFleet.js";
import { maintainFleet } from "./fleetRestart.js";
import { log } from "../util/logger.js";

let fleetPaused = false;

export function isFleetPaused(): boolean {
  return fleetPaused;
}

export function setFleetPaused(v: boolean): void {
  fleetPaused = !!v;
}

export async function cancelAccountOpenOrders(exchange: GridExchangeAdapter): Promise<number> {
  const fn = (exchange as GridExchangeAdapter & { cancelAllAccountOrders?: () => Promise<number> })
    .cancelAllAccountOrders;
  if (!fn) return 0;
  const n = await fn().catch(() => 0);
  if (n > 0) log.info(`[Grid] 已清理账户残留挂单 ${n} 笔`);
  return n;
}

export async function pauseFleet(
  fleet: GridFleet,
  exchange?: GridExchangeAdapter | null
): Promise<Record<string, unknown>> {
  setFleetPaused(true);
  await fleet.stop({ closePosition: false });
  if (exchange && "clearWatch" in exchange) {
    (exchange as { clearWatch: () => void }).clearWatch();
  }
  if (exchange) await cancelAccountOpenOrders(exchange);
  return { paused: true, ...fleet.getState() };
}

export async function resumeFleet(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  fleetOpts: { slotCount: number; candidateNames: string[]; preferSymbols?: string[]; exchangeLabel?: string }
): Promise<Record<string, unknown>> {
  setFleetPaused(false);
  await maintainFleet(fleet, exchange, fleetOpts).catch(() => null);
  return { paused: false, ...fleet.getState() };
}

export async function closeOrphanPositions(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  exchangeLabel?: string
): Promise<number> {
  const runningIds = new Set(fleet.runningMarketIds());
  if (!runningIds.size) return 0;
  const getAll = (
    exchange as GridExchangeAdapter & {
      getAllPositions?: () => { marketId: number; market: string; side: string }[];
    }
  ).getAllPositions;
  if (!getAll) return 0;
  const positions = getAll.call(exchange);
  let closed = 0;
  for (const p of positions) {
    if (!p.marketId || runningIds.has(p.marketId)) continue;
    try {
      await exchange.closePosition(p.marketId);
      closed++;
      log.info(`[Grid/${exchangeLabel ?? ""}] 平掉换槽残留 ${p.market} ${p.side}`);
    } catch (e: any) {
      log.warn(`[Grid/${exchangeLabel ?? ""}] 平残留 ${p.market} 失败: ${e?.message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return closed;
}

export async function closeAllPositions(exchange: GridExchangeAdapter): Promise<{ closed: unknown[]; count: number }> {
  const refresh = (exchange as GridExchangeAdapter & { refreshAllPositions?: () => Promise<void> })
    .refreshAllPositions;
  if (refresh) await refresh.call(exchange).catch(() => {});
  const getAll = (exchange as GridExchangeAdapter & { getAllPositions?: () => { marketId: number; market: string }[] })
    .getAllPositions;
  const positions = getAll ? getAll.call(exchange) : [];
  const closed: { market: string; ok: boolean; error?: string }[] = [];
  for (const p of positions) {
    if (!p.marketId) {
      closed.push({ market: p.market, ok: false, error: "未知 marketId" });
      continue;
    }
    try {
      await exchange.closePosition(p.marketId);
      closed.push({ market: p.market, ok: true });
    } catch (e: any) {
      closed.push({ market: p.market, ok: false, error: e?.message ?? String(e) });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return { closed, count: closed.filter((c) => c.ok).length };
}
