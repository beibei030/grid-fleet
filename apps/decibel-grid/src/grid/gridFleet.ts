import { GridBot } from "./gridBot.js";
import { isFleetPaused } from "./fleetControl.js";
import type { GridAdapterExtras } from "./gridLiveTypes.js";
import type { GridExchangeAdapter } from "./iExchange.js";
import type { GridJournal } from "./gridJournal.js";

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function startOfTodayMs(timeZone = "Asia/Shanghai"): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const msInDay = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + now.getMilliseconds();
  return now.getTime() - msInDay;
}

function sumTodayVolumeFromFills(fills: Array<{ t?: unknown; price?: unknown; size?: unknown }>): number {
  const dayStart = startOfTodayMs();
  let vol = 0;
  for (const f of fills) {
    const t = Number(f.t);
    if (!Number.isFinite(t) || t < dayStart) continue;
    const price = Number(f.price);
    const size = Math.abs(Number(f.size));
    if (Number.isFinite(price) && Number.isFinite(size)) vol += price * size;
  }
  return round2(vol);
}

export class GridFleet {
  private ex: GridExchangeAdapter;
  private journal: GridJournal | null;
  private bots = new Map<number, GridBot>();
  fleetMeta: Record<string, unknown> = {};

  constructor(exchange: GridExchangeAdapter, journal: GridJournal | null = null) {
    this.ex = exchange;
    this.journal = journal;
  }

  bot(marketId: number): GridBot {
    const id = Number(marketId);
    if (!this.bots.has(id)) this.bots.set(id, new GridBot(this.ex, this.journal));
    return this.bots.get(id)!;
  }

  async start(cfg: Parameters<GridBot["start"]>[0]) {
    return this.bot(cfg.marketId).start(cfg);
  }

  async stop(opts: { marketId?: number; closePosition?: boolean } = {}) {
    const { marketId, closePosition = false } = opts;
    if (marketId != null) {
      const b = this.bots.get(Number(marketId));
      if (!b?.running) return this.getState();
      await b.stop({ closePosition });
      return this.getState();
    }
    for (const b of this.bots.values()) {
      if (b.running) await b.stop({ closePosition });
    }
    return this.getState();
  }

  runningMarketIds(): number[] {
    return [...this.bots.values()].filter((b) => b.running).map((b) => b.config!.marketId);
  }

  isRunning(marketId: number): boolean {
    return !!this.bots.get(marketId)?.running;
  }

  removeBot(marketId: number): void {
    this.bots.delete(marketId);
  }

  getState() {
    const bots = [...this.bots.values()]
      .map((b) => b.getState())
      .filter((s) => s.running || s.config);
    const runningBots = bots.filter((s) => s.running);

    let posUnrealized = 0;
    let openOrders = 0;
    for (const s of runningBots) {
      posUnrealized += (s.unrealizedPnl as number) || 0;
      openOrders += (s.openOrders as number) || 0;
    }

    const aggStats = this.journal
      ? this.journal.getStats()
      : runningBots.reduce(
          (a, s) => {
            const st = s.stats as Record<string, number> | undefined;
            if (!st) return a;
            a.buys += st.buys || 0;
            a.sells += st.sells || 0;
            a.completedRungs += st.completedRungs || 0;
            a.gridProfit += st.gridProfit || 0;
            a.volume = (a.volume || 0) + (st.volume || 0);
            return a;
          },
          { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 }
        );

    const balance = typeof this.ex.balance === "number" ? round2(this.ex.balance) : null;
    const apiUnrealized = typeof this.ex.unrealisedPnl === "number" ? round2(this.ex.unrealisedPnl) : null;
    const unrealized = apiUnrealized != null ? apiUnrealized : round2(posUnrealized);
    const equity =
      typeof this.ex.equity === "number"
        ? round2(this.ex.equity)
        : balance != null
          ? round2(balance + unrealized)
          : null;
    const baseline = this.journal?.getBaselineEquity() ?? null;
    const gridProfit = round2(aggStats.gridProfit || 0);
    const accountPnl = equity != null && baseline != null ? round2(equity - baseline) : null;
    const returnPct =
      baseline != null && baseline > 0 && accountPnl != null ? round2((accountPnl / baseline) * 100) : null;

    const fills = this.journal
      ? this.journal.getFills(80)
      : runningBots
          .flatMap((s) =>
            ((s.fills as Record<string, unknown>[]) || []).map((f) => ({
              ...f,
              symbol: f.symbol || (s.config as any)?.displayName,
              marketId: f.marketId ?? (s.config as any)?.marketId,
            }))
          )
          .sort((a, b) => Number((b as { t?: number }).t) - Number((a as { t?: number }).t))
          .slice(0, 80);

    const alerts = this.journal
      ? this.journal.getAlerts(40)
      : runningBots
          .flatMap((s) =>
            ((s.alerts as { t: number; message: string }[]) || []).map((a) => ({
              ...a,
              symbol: (s.config as any)?.displayName,
              marketId: (s.config as any)?.marketId,
            }))
          )
          .sort((a, b) => b.t - a.t)
          .slice(0, 40);

    const openOrdersList = runningBots.flatMap((s) =>
      ((s.openOrdersList as Record<string, unknown>[]) || []).map((o) => ({
        ...o,
        symbol: (s.config as any)?.displayName,
        marketId: (s.config as any)?.marketId,
      }))
    );

    const primary = runningBots[0] || bots[0] || null;

    const exExtra = this.ex as GridExchangeAdapter & GridAdapterExtras;
    const official = exExtra.getOfficialStats?.() ?? null;
    const displayVolume =
      official?.volume != null ? round2(Number(official.volume)) : round2(aggStats.volume || 0);
    const unrealizedFinal =
      official?.unrealizedPnl != null ? round2(official.unrealizedPnl) : unrealized;
    const equityFinal =
      typeof this.ex.equity === "number"
        ? round2(this.ex.equity)
        : balance != null
          ? round2(balance + unrealizedFinal)
          : equity;
    const realizedPnl = official?.realizedPnl != null ? round2(official.realizedPnl) : null;
    const totalPnl = official?.totalPnl != null ? round2(official.totalPnl) : null;
    const feesPaid = official?.feesPaid != null ? round2(official.feesPaid) : null;
    const recentClosed = official?.recentClosed ?? [];

    const runningNames = new Set(
      runningBots.map((b) => (b.config as { displayName?: string })?.displayName).filter(Boolean)
    );
    const livePositions = (exExtra.getAllPositions?.() ?? []).map((p) => ({
      ...p,
      inFleet: runningNames.has(p.market),
    }));

    const journalFills = this.journal ? this.journal.getFills(500) : fills;
    const todayVolume = sumTodayVolumeFromFills(journalFills as Array<{ t?: unknown; price?: unknown; size?: unknown }>);

    return {
      exchange: this.fleetMeta.exchange ?? "unknown",
      mode: this.ex.mode,
      running: runningBots.length > 0,
      botCount: runningBots.length,
      bots,
      livePositions,
      balance,
      equity: equityFinal,
      volume: displayVolume,
      todayVolume,
      openOrders,
      openOrdersList,
      stats: aggStats,
      gridProfit,
      feesPaid,
      baselineEquity: baseline,
      baselineSetAt: this.journal?.getBaselineSetAt() ?? null,
      official: official
        ? {
            realizedPnl,
            unrealizedPnl: unrealizedFinal,
            totalPnl,
            feesPaid,
            pnlSource: official.pnlSource,
            updatedAt: official.updatedAt,
            volume: official.volume ?? null,
            tradeCount: official.tradeCount ?? null,
            volumeSource: official.volumeSource ?? null,
            statsWindow: official.statsWindow ?? null,
          }
        : null,
      realizedPnl,
      unrealizedPnl: unrealizedFinal,
      totalPnl,
      accountPnl,
      returnPct,
      recentClosed,
      fills,
      alerts,
      journalPersisted: !!this.journal,
      fleetMeta: { ...this.fleetMeta, paused: isFleetPaused() } as Record<string, unknown>,
      config: primary?.config ?? null,
      grid: primary?.grid ?? null,
      lastPrice: primary?.lastPrice ?? null,
      outOfRange: runningBots.some((s) => s.outOfRange),
      risk: primary?.risk ?? null,
      openByLevel: primary?.openByLevel ?? {},
      position: primary?.position ?? null,
    };
  }
}

export type GridFleetState = ReturnType<GridFleet["getState"]>;
