import type { GridFleetState } from "./gridFleet.js";
import type { VenueGridManager } from "./gridManager.js";
import { isFleetPaused } from "./fleetControl.js";

export interface LivePositionRow {
  market: string;
  side: string;
  leverage?: number;
  valueUsd: number;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPct?: number | null;
  inFleet: boolean;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 对齐 extended-grid fleet.getState() 的 UI 字段 */
export async function enrichGridFleetState(
  mgr: VenueGridManager,
  opts: { paused?: boolean; activeSlots?: number } = {}
): Promise<Record<string, unknown>> {
  const st = mgr.getState();
  if (!st) return { running: false, botCount: 0, bots: [] };

  const runningBots = (st.bots || []).filter((b) => b.running);
  const runningNames = new Set(
    runningBots.map((b) => (b.config as { displayName?: string } | null)?.displayName).filter(Boolean)
  );
  const botLeverage = new Map(
    runningBots.map((b) => {
      const cfg = b.config as { displayName?: string; leverage?: number } | null;
      return [cfg?.displayName, cfg?.leverage] as const;
    })
  );

  const adapter = mgr.getExchangeAdapter();

  let livePositions: LivePositionRow[] = [];
  if (adapter && "getAllPositions" in adapter && typeof adapter.getAllPositions === "function") {
    try {
      const rows = await Promise.resolve(
        (adapter as { getAllPositions: () => LivePositionRow[] | Promise<LivePositionRow[]> }).getAllPositions()
      );
      livePositions = rows.map((p) => ({
        ...p,
        leverage: p.leverage ?? botLeverage.get(p.market) ?? undefined,
        inFleet: runningNames.has(p.market),
      }));
    } catch {
      /* ignore */
    }
  }

  if (!livePositions.length) {
    livePositions = runningBots
      .map((b) => {
        const cfg = b.config as Record<string, unknown> | null;
        const pos = b.position as { sizeBase?: number; entryPrice?: number; unrealizedPnl?: number } | null;
        const sz = pos?.sizeBase ?? 0;
        if (Math.abs(sz) < 1e-12) return null;
        const mark = Number(b.lastPrice) || 0;
        const side = sz > 0 ? "long" : "short";
        const name = String(cfg?.displayName ?? cfg?.symbol ?? "?");
        return {
          market: name,
          side,
          leverage: Number(cfg?.leverage) || undefined,
          valueUsd: Math.abs(sz) * mark,
          size: Math.abs(sz),
          entryPrice: pos?.entryPrice ?? Number(cfg?.center) ?? 0,
          markPrice: mark,
          unrealizedPnl: pos?.unrealizedPnl ?? (b.unrealizedPnl as number) ?? 0,
          inFleet: true,
        };
      })
      .filter(Boolean) as LivePositionRow[];
  }

  let official: Record<string, unknown> | null = null;
  let realizedPnl: number | null = null;
  let totalPnl: number | null = null;
  let feesPaid: number | null = null;
  let recentClosed: unknown[] = [];

  if (adapter && "getOfficialStats" in adapter && typeof adapter.getOfficialStats === "function") {
    try {
      official = await Promise.resolve(
        (adapter as { getOfficialStats: () => Record<string, unknown> | null | Promise<Record<string, unknown> | null> }).getOfficialStats()
      );
      if (official) {
        realizedPnl = official.realizedPnl != null ? round2(Number(official.realizedPnl)) : null;
        totalPnl = official.totalPnl != null ? round2(Number(official.totalPnl)) : null;
        feesPaid = official.feesPaid != null ? round2(Number(official.feesPaid)) : null;
        recentClosed = (official.recentClosed as unknown[]) || [];
      }
    } catch {
      /* ignore */
    }
  }

  const baseline = st.baselineEquity ?? null;
  const accountPnl =
    st.accountPnl != null
      ? st.accountPnl
      : st.equity != null && baseline != null
        ? round2(st.equity - baseline)
        : null;

  const managedIds = new Set<string>();
  const runningMarketIds = new Set<number>();
  for (const b of runningBots) {
    const mid = (b.config as { marketId?: number } | null)?.marketId;
    if (mid != null) runningMarketIds.add(mid);
    const ids = (b as { activeOrderIds?: string[] }).activeOrderIds;
    if (ids) for (const id of ids) managedIds.add(id);
  }

  let openOrders = st.openOrders ?? 0;
  let openOrdersList = (st.openOrdersList as Record<string, unknown>[]) ?? [];
  let orphanOpenOrders = 0;

  const exExtra = adapter as typeof adapter & {
    getAllOpenOrdersLive?: () => Promise<
      { orderId: string; marketId: number; symbol: string; side: string; price: number; sizeBase: number; levelIndex?: number }[]
    >;
  };
  if (exExtra?.getAllOpenOrdersLive) {
    try {
      const live = await exExtra.getAllOpenOrdersLive();
      openOrdersList = live.map((o) => {
        const inBot = managedIds.has(o.orderId);
        let strayKind: "offSlot" | "unmanaged" | null = null;
        if (!inBot) strayKind = runningMarketIds.has(o.marketId) ? "unmanaged" : "offSlot";
        return {
          orderId: o.orderId,
          symbol: o.symbol,
          marketId: o.marketId,
          side: o.side,
          price: round2(o.price),
          sizeBase: o.sizeBase,
          levelIndex: o.levelIndex,
          inBot,
          strayKind,
        };
      });
      openOrders = openOrdersList.length;
      orphanOpenOrders = openOrdersList.filter((o) => o.strayKind != null).length;
    } catch {
      /* keep fleet snapshot */
    }
  }

  return {
    ...st,
    openOrders,
    openOrdersList,
    orphanOpenOrders,
    botOpenOrders: managedIds.size,
    livePositions,
    recentClosed,
    accountPnl,
    realizedPnl,
    totalPnl,
    feesPaid,
    official: official
      ? {
          ...official,
          pnlSource: official.pnlSource ?? "api",
        }
      : null,
    fleetMeta: {
      ...(st.fleetMeta as object),
      activeSlots: opts.activeSlots ?? runningBots.length,
      paused: opts.paused ?? isFleetPaused(),
      exchange: mgr.exchangeLabel,
    },
  };
}

export type EnrichedGridState = Awaited<ReturnType<typeof enrichGridFleetState>>;
