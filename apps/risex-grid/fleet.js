import { GridBot } from './bot.js';
import { ACTIVE_SLOTS, CANDIDATE_NAMES, FLEET_DEFAULTS, FIXED_ALLOC } from './fleet-plan.js';
import { isFleetPaused } from './fleet-control.js';

function round2(x) { return Math.round(x * 100) / 100; }

/** 多标的网格：每个 marketId 独立 GridBot，共享同一 RISEx 连接。 */
export class GridFleet {
  constructor(exchange, journal = null) {
    this.ex = exchange;
    this.journal = journal;
    /** @type {Map<number, GridBot>} */
    this.bots = new Map();
  }

  bot(marketId) {
    const id = Number(marketId);
    if (!this.bots.has(id)) this.bots.set(id, new GridBot(this.ex, this.journal));
    return this.bots.get(id);
  }

  async start(cfg) {
    return this.bot(cfg.marketId).start(cfg);
  }

  async stop({ marketId, closePosition = false } = {}) {
    if (marketId != null && marketId !== '') {
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

  getState() {
    const bots = [...this.bots.values()]
      .map((b) => b.getState())
      .filter((s) => s.running || s.config);
    const runningBots = bots.filter((s) => s.running);

    let posUnrealized = 0;
    let botOpenOrders = 0;

    for (const s of runningBots) {
      posUnrealized += s.unrealizedPnl || 0;
      botOpenOrders += s.botOpenOrders ?? s.openOrders ?? 0;
    }

    const runningBotObjs = [...this.bots.values()].filter((b) => b.running);
    const exchangeUpdatedAt = this.ex.getOfficialOpenOrdersUpdatedAt?.() ?? 0;
    let openOrders = 0;
    let openOrdersList = [];
    let openOrdersSource = 'bot';

    if (exchangeUpdatedAt > 0 && runningBotObjs.length) {
      openOrdersSource = 'exchange';
      for (const bot of runningBotObjs) {
        const mId = bot.config.marketId;
        const cached = this.ex.getCachedOpenOrders?.(mId) || [];
        openOrders += cached.length;
        for (const o of cached) {
          const local = bot.active.get(o.orderId);
          openOrdersList.push({
            ...o,
            levelIndex: local?.levelIndex ?? matchLevelIndex(bot, o.price),
            symbol: bot.config.displayName,
            marketId: mId,
            source: 'exchange',
          });
        }
      }
    } else {
      openOrders = botOpenOrders;
      openOrdersList = runningBots.flatMap((s) =>
        (s.openOrdersList || []).map((o) => ({
          ...o,
          symbol: s.config?.displayName,
          marketId: s.config?.marketId,
        }))
      );
    }

    let accountOpenOrders = 0;
    const countedMarkets = new Set();
    for (const bot of this.bots.values()) {
      const mId = bot.config?.marketId;
      if (!mId || countedMarkets.has(mId)) continue;
      countedMarkets.add(mId);
      accountOpenOrders += (this.ex.getCachedOpenOrders?.(mId) || []).length;
    }
    for (const p of this.ex.getAllPositions?.() || []) {
      const mId = p.marketId;
      if (!mId || countedMarkets.has(mId)) continue;
      countedMarkets.add(mId);
      accountOpenOrders += (this.ex.getCachedOpenOrders?.(mId) || []).length;
    }
    if (accountOpenOrders < openOrders) accountOpenOrders = openOrders;

    const aggStats = this.journal
      ? this.journal.getStats()
      : runningBots.reduce((a, s) => {
          if (!s.stats) return a;
          a.buys += s.stats.buys || 0;
          a.sells += s.stats.sells || 0;
          a.completedRungs += s.stats.completedRungs || 0;
          a.gridProfit += s.stats.gridProfit || 0;
          a.volume = (a.volume || 0) + (s.stats.volume || 0);
          return a;
        }, { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 });

    const volume = round2(aggStats.volume || 0);

    const apiEquity = typeof this.ex.equity === 'number' ? round2(this.ex.equity) : null;
    const apiUnrealized = typeof this.ex.unrealisedPnl === 'number' ? round2(this.ex.unrealisedPnl) : null;

    const balance = typeof this.ex.balance === 'number' ? round2(this.ex.balance) : null;

    const baseline = this.journal?.getBaselineEquity?.() ?? null;
    const gridProfit = round2(aggStats.gridProfit || 0);
    const official = this.ex.getOfficialStats?.() || null;

    const sessionSince = this.journal?.getSessionStartAt?.() ?? this.journal?.getBaselineSetAt?.() ?? 0;
    const officialFillsRaw = this.ex.getOfficialFills?.(80, sessionSince)
      || (official?.officialFills || []).filter((f) => !sessionSince || f.t >= sessionSince).slice(0, 80);
    const officialFillCount = officialFillsRaw.length;
    const displayVolume = official?.volume != null ? round2(official.volume) : volume;

    const unrealized = official?.unrealizedPnl != null
      ? round2(official.unrealizedPnl)
      : (apiUnrealized != null ? apiUnrealized : round2(posUnrealized));
    const equity = apiEquity ?? (balance != null ? round2(balance + unrealized) : null);
    const realizedPnl = official?.realizedPnl != null ? round2(official.realizedPnl) : null;
    const totalPnl = official?.totalPnl != null ? round2(official.totalPnl) : null;
    const feesPaid = official?.feesPaid != null ? round2(official.feesPaid) : null;
    const recentClosed = official?.recentClosed || [];
    const officialByMarket = official?.byMarket || {};

    const accountPnl = (equity != null && baseline != null) ? round2(equity - baseline) : null;

    const baselineOfficialTotal = this.journal?.getBaselineOfficialTotalPnl?.() ?? null;
    let roundPnl = null;
    if (totalPnl != null && baselineOfficialTotal != null) {
      roundPnl = round2(totalPnl - baselineOfficialTotal);
    } else if (accountPnl != null) {
      roundPnl = accountPnl;
    }

    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const dayStartMs = new Date(`${dayKey}T00:00:00+08:00`).getTime();
    const dayOfficialFills = this.ex.getOfficialFills?.(500, dayStartMs)
      || (official?.officialFills || []).filter((f) => f.t >= dayStartMs);
    const todayOfficialRealized = round2(dayOfficialFills.reduce((s, f) => s + (f.realizedPnl || 0), 0));
    const todayOfficialVolume = round2(dayOfficialFills.reduce((s, f) => s + Math.abs((f.price || 0) * (f.size || 0)), 0));

    const displayPnl = roundPnl;
    const returnPct = (baseline != null && baseline > 0 && displayPnl != null)
      ? round2((displayPnl / baseline) * 100)
      : null;

    const baselineSetAt = this.journal?.getBaselineSetAt?.() ?? null;
    const allClosed = official?.allClosed || [];

    const roundRealizedFor = (name, startedAt) => {
      const since = Math.max(baselineSetAt || 0, startedAt || 0);
      if (!since || !name) return 0;
      return round2(
        allClosed
          .filter((p) => p.market === name && p.closedTime >= since)
          .reduce((s, p) => s + (p.realizedPnl || 0), 0)
      );
    };

    const botsWithOfficial = bots.map((b) => {
      const name = b.config?.displayName;
      const om = name ? officialByMarket[name] : null;
      const roundRealized = b.running && name ? roundRealizedFor(name, b.startedAt) : null;
      const unrealDelta = b.running ? round2((b.unrealizedPnl ?? 0) - (b.startUnrealized ?? 0)) : null;
      const roundPnl = (roundRealized != null && unrealDelta != null)
        ? round2(roundRealized + unrealDelta)
        : null;
      return {
        ...b,
        officialRealized: om ? round2(om.realizedPnl) : null,
        officialFees: om ? round2(om.fees) : null,
        roundRealized,
        roundPnl,
      };
    });

    const fills = officialFillsRaw.length
      ? officialFillsRaw.map((f) => ({
          id: f.id,
          t: f.t,
          side: f.side,
          price: f.price,
          size: f.size,
          symbol: f.market,
          marketId: f.marketId,
          realizedPnl: f.realizedPnl,
          official: true,
        }))
      : (this.journal
        ? this.journal.getFills(80)
        : runningBots.flatMap((s) => (s.fills || []).map((f) => ({
            ...f,
            symbol: f.symbol || s.config?.displayName,
            marketId: f.marketId ?? s.config?.marketId,
          }))).sort((a, b) => b.t - a.t).slice(0, 80));

    const alerts = this.journal
      ? this.journal.getAlerts(40)
      : runningBots.flatMap((s) => (s.alerts || []).map((a) => ({
          ...a,
          symbol: s.config?.displayName,
          marketId: s.config?.marketId,
        }))).sort((a, b) => b.t - a.t).slice(0, 40);

    const openOrdersDrift = botOpenOrders - openOrders;

    const primary = runningBots[0] || bots[0] || null;

    const runningNames = new Set(runningBots.map((b) => b.config?.displayName).filter(Boolean));
    const gridLevByMarket = new Map(runningBots.map((b) => [b.config?.displayName, b.config?.leverage]));
    const livePositions = (this.ex.getAllPositions?.() || []).map((p) => ({
      ...p,
      inFleet: runningNames.has(p.market),
      gridLeverage: gridLevByMarket.get(p.market) ?? null,
    }));

    const orphanOrders = this.ex._orphanOrderMarkets ?? [];
    const orphanOrderCount = orphanOrders.reduce((n, o) => n + (o.count || 0), 0);

    return {
      mode: this.ex.mode,
      running: runningBots.length > 0,
      botCount: runningBots.length,
      bots: botsWithOfficial,
      livePositions,
      orphanOrders,
      orphanOrderCount,
      balance,
      equity,
      volume: displayVolume,
      officialFillCount,
      openOrders,
      accountOpenOrders,
      openOrdersList,
      openOrdersSource,
      botOpenOrders,
      openOrdersDrift,
      openOrdersUpdatedAt: exchangeUpdatedAt || null,
      stats: aggStats,
      gridProfit,
      feesPaid,
      baselineEquity: baseline,
      baselineSetAt: this.journal?.getBaselineSetAt?.() ?? null,
      baselineOfficialTotalPnl: baselineOfficialTotal,
      official: official ? {
        realizedPnl,
        unrealizedPnl: unrealized,
        totalPnl,
        feesPaid,
        volume: displayVolume,
        pnlSource: official.pnlSource,
        updatedAt: official.updatedAt,
      } : null,
      todayOfficialRealized,
      todayOfficialVolume,
      realizedPnl,
      unrealizedPnl: unrealized,
      totalPnl,
      accountPnl: displayPnl,
      equityPnl: accountPnl,
      roundPnl,
      returnPct,
      recentClosed,
      fills,
      alerts,
      journalPersisted: !!this.journal,
      fleetMeta: {
        profile: FLEET_DEFAULTS.FIXED_SLOTS ? 'rise-fixed' : 'dynamic',
        activeSlots: ACTIVE_SLOTS,
        candidatePool: CANDIDATE_NAMES,
        fixedAlloc: FLEET_DEFAULTS.FIXED_SLOTS ? FIXED_ALLOC : null,
        budgetUse: FLEET_DEFAULTS.BUDGET_USE,
        autoRecenter: true,
        paused: isFleetPaused(),
        hotSwap: FLEET_DEFAULTS.HOT_SWAP_ENABLED,
        trendLinked: FLEET_DEFAULTS.TREND_LINKED_MODE,
        rotationCheckMin: Math.round((FLEET_DEFAULTS.ROTATION_CHECK_MS || 0) / 60_000),
      },
      // 兼容旧字段：默认展示第一个运行中 bot
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

function matchLevelIndex(bot, price) {
  if (!bot.grid?.levels?.length || !(price > 0)) return null;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < bot.grid.levels.length; i++) {
    const d = Math.abs(bot.grid.levels[i] - price);
    if (d < bestD) { bestD = d; best = i; }
  }
  const tol = (bot.grid.spacing || 1) * 0.55;
  return bestD <= tol ? best : null;
}
