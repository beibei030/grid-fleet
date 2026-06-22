import type { DecibelExchange } from "../../exchanges/decibelExchange.js";
import type { GridFill, GridMarket, GridOrder, GridPosition } from "../iExchange.js";
import { GridExchangeAdapter } from "../iExchange.js";
import type { GridCandle } from "../trend.js";
import type { GridLivePosition, GridOfficialStats } from "../gridLiveTypes.js";
import { log } from "../../util/logger.js";

interface TrackedOrder {
  marketId: number;
  symbol: string;
  levelIndex?: number;
  side: "buy" | "sell";
  price: number;
  sizeBase: number;
  placedAt: number;
  clientOrderId?: string;
}

/** Decibel 网格适配器：VPS 直连，轮询 open orders 检测成交 */
export class DecGridExchange extends GridExchangeAdapter {
  readonly mode = "live";
  readonly dataSource = "real";
  readonly network = "mainnet";
  private markets = new Map<number, GridMarket>();
  private symbolToId = new Map<string, number>();
  private tracked = new Map<string, TrackedOrder>();
  private openCache = new Map<number, GridOrder[]>();
  private positions = new Map<number, GridPosition>();
  private prices = new Map<number, number>();
  private watch = new Set<number>();
  private allPositions: GridLivePosition[] = [];
  private officialStats: GridOfficialStats | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private pollMs: number;

  private officialRefreshMs = 60_000;
  private lastOfficialRefresh = 0;
  /** 主动撤单 ID：poll 时勿误判为成交 */
  private cancelledIds = new Set<string>();
  /** 播种/重挂期间禁用成交推断 */
  private fillGuard = new Set<number>();
  /** 订单首次从 open 列表消失的时间，需持续消失才认定成交 */
  private missingSince = new Map<string, number>();
  /** 新下单后至少等这么久才参与成交推断（Aptos 索引延迟） */
  private readonly minOrderAgeMs = 10_000;
  /** 从 open 消失需持续这么久才 emit fill */
  private readonly fillConfirmMs = 12_000;
  /** endSeeding 后再等多久解除 fillGuard */
  private readonly seedGraceMs = 12_000;

  constructor(
    private dec: DecibelExchange,
    pollMs = 5000
  ) {
    super();
    this.pollMs = pollMs;
  }

  async init(): Promise<void> {
    const list = await this.dec.getMarkets();
    const sorted = [...list].sort((a, b) => (b.markPrice || 0) - (a.markPrice || 0));
    let id = 1;
    this.markets.clear();
    this.symbolToId.clear();
    for (const m of sorted) {
      if (!(m.markPrice > 0)) continue;
      const gm: GridMarket = {
        marketId: id,
        displayName: m.symbol,
        symbol: m.symbol,
        lastPrice: m.markPrice,
        stepSize: m.lotSize || m.minOrderSize || 0.01,
        stepPrice: m.tickSize || 0.01,
        maxLeverage: m.maxLeverage || 20,
        minOrderSize: m.minOrderSize || 0.01,
      };
      this.markets.set(id, gm);
      this.symbolToId.set(m.symbol.toUpperCase(), id);
      this.prices.set(id, m.markPrice);
      id++;
    }
    await this.refreshAccount();
    await this.refreshAllPositions().catch(() => {});
    await this.refreshOfficialStats().catch(() => {});
  }

  getAllPositions(): GridLivePosition[] {
    return this.allPositions.map((p) => ({ ...p }));
  }

  getOfficialStats(): GridOfficialStats | null {
    return this.officialStats ? { ...this.officialStats } : null;
  }

  async refreshAllPositions(): Promise<void> {
    const positions = await this.dec.getPositions().catch(() => []);
    const parsed: GridLivePosition[] = [];
    for (const p of positions) {
      const marketId = this.symbolToId.get(p.symbol.toUpperCase()) ?? 0;
      const gm = marketId ? this.markets.get(marketId) : null;
      const mark = p.markPrice > 0 ? p.markPrice : gm?.lastPrice ?? p.entryPrice;
      const valueUsd = mark > 0 ? p.size * mark : p.entryPrice * p.size;
      const unrealizedPct =
        p.entryPrice > 0 ? ((mark - p.entryPrice) / p.entryPrice) * 100 * (p.side === "short" ? -1 : 1) : 0;
      const lev = await this.dec.getMarketLeverage(p.symbol).catch(() => null);
      parsed.push({
        market: gm?.displayName ?? p.symbol,
        marketId,
        side: p.side,
        size: p.size,
        sizeBase: p.side === "short" ? -p.size : p.size,
        entryPrice: p.entryPrice,
        markPrice: mark,
        valueUsd: Math.round(valueUsd * 100) / 100,
        unrealizedPnl: p.unrealizedPnl ?? 0,
        unrealizedPct: Math.round(unrealizedPct * 100) / 100,
        leverage: lev,
        liquidationPrice: p.liqPrice ?? null,
      });
    }
    parsed.sort((a, b) => Math.abs(b.valueUsd) - Math.abs(a.valueUsd));
    this.allPositions = parsed;
  }

  async refreshOfficialStats(): Promise<void> {
    const prev = this.officialStats;
    const [stats, tradeStats] = await Promise.all([
      this.dec.getAccountStats().catch(() => null),
      this.dec.getOfficialTradeStats().catch(() => null),
    ]);
    const unrealized = stats?.unrealizedPnl ?? null;
    const realizedFromApi = stats?.realizedPnl ?? null;
    const realizedFromTrades = tradeStats?.realizedPnl ?? null;
    const realized = realizedFromApi ?? realizedFromTrades ?? prev?.realizedPnl ?? null;
    const totalPnl =
      realized != null && unrealized != null ? realized + unrealized : realized ?? unrealized;

    const accountVol = stats?.volume;
    let volume: number | null = null;
    let volumeSource: string | null = null;
    let statsWindow: string | null = null;
    if (accountVol != null) {
      volume = accountVol;
      volumeSource = "账户概览";
      statsWindow = stats?.statsWindow ?? "近30日";
    } else if (prev?.volume != null && prev.volumeSource === "账户概览") {
      volume = prev.volume;
      volumeSource = prev.volumeSource;
      statsWindow = prev.statsWindow ?? "近30日";
    } else if (tradeStats?.volume != null) {
      volume = tradeStats.volume;
      volumeSource = "成交汇总";
      statsWindow = "近2000笔";
    }

    this.officialStats = {
      realizedPnl: realized ?? null,
      unrealizedPnl: unrealized ?? null,
      totalPnl: totalPnl != null ? Math.round(totalPnl * 100) / 100 : null,
      pnlSource: realizedFromApi != null ? "account" : "trades",
      feesPaid: stats?.feesPaid ?? tradeStats?.fees ?? prev?.feesPaid ?? null,
      volume,
      volumeSource,
      statsWindow,
      tradeCount: tradeStats?.tradeCount ?? prev?.tradeCount ?? null,
      byMarket: {},
      allClosed: tradeStats?.recentClosed ?? [],
      recentClosed: tradeStats?.recentClosed ?? [],
      updatedAt: Date.now(),
    };
  }

  async getMarkets(): Promise<GridMarket[]> {
    return [...this.markets.values()];
  }

  async getCandles(marketId: number, intervalSec = 900, n = 96): Promise<GridCandle[]> {
    const m = this.markets.get(marketId);
    if (!m) return [];
    return this.dec.getCandles(m.symbol, intervalSec, n).catch(() => []);
  }

  marketForSymbol(symbol: string): GridMarket | undefined {
    const id = this.symbolToId.get(symbol.toUpperCase());
    return id != null ? this.markets.get(id) : undefined;
  }

  async getPrice(marketId: number): Promise<number> {
    const m = this.markets.get(marketId);
    if (!m) throw new Error(`unknown marketId ${marketId}`);
    const info = await this.dec.getMarket(m.symbol);
    const px = info?.markPrice ?? this.prices.get(marketId) ?? m.lastPrice;
    this.prices.set(marketId, px);
    m.lastPrice = px;
    return px;
  }

  async setLeverage(marketId: number, leverage: number): Promise<void> {
    const m = this.markets.get(marketId);
    if (!m) throw new Error(`未知 marketId ${marketId}`);
    await this.dec.setLeverage(m.symbol, leverage);
  }

  async getCurrentLeverage(marketId: number): Promise<number | null> {
    const m = this.markets.get(marketId);
    if (!m) return null;
    return this.dec.getMarketLeverage(m.symbol);
  }

  async placeLimitOrder(o: {
    marketId: number;
    side: "buy" | "sell";
    price: number;
    sizeBase: number;
    reduceOnly?: boolean;
    levelIndex?: number;
    clientOrderId?: number;
  }): Promise<{ orderId: string } | null> {
    const m = this.markets.get(o.marketId);
    if (!m) return null;
    this.watch.add(o.marketId);
    const res = await this.dec.placeLimitOrder({
      symbol: m.symbol,
      side: o.side === "buy" ? "long" : "short",
      size: o.sizeBase,
      price: o.price,
      reduceOnly: o.reduceOnly,
      clientId: o.clientOrderId != null ? String(o.clientOrderId) : undefined,
      postOnly: true,
    });
    if (!res.ok || !res.orderId) throw new Error(res.error ?? "placeLimitOrder failed");
    const clientKey = o.clientOrderId != null ? String(o.clientOrderId) : undefined;
    this.tracked.set(res.orderId, {
      marketId: o.marketId,
      symbol: m.symbol,
      levelIndex: o.levelIndex,
      side: o.side,
      price: o.price,
      sizeBase: o.sizeBase,
      placedAt: Date.now(),
      clientOrderId: clientKey,
    });
    this.missingSince.delete(res.orderId);
    return { orderId: res.orderId };
  }

  async cancelOrder(marketId: number, orderId: string): Promise<void> {
    const m = this.markets.get(marketId);
    if (!m) return;
    this.cancelledIds.add(orderId);
    this.tracked.delete(orderId);
    this.missingSince.delete(orderId);
    await this.dec.cancelOrderById(m.symbol, orderId).catch(() => {});
  }

  async cancelAll(marketId: number): Promise<void> {
    const m = this.markets.get(marketId);
    if (!m) return;
    for (const [id, tr] of this.tracked.entries()) {
      if (tr.marketId === marketId) this.cancelledIds.add(id);
    }
    this.tracked.forEach((tr, id) => {
      if (tr.marketId === marketId) {
        this.tracked.delete(id);
        this.missingSince.delete(id);
      }
    });
    await this.dec.cancelAllOpenOrders(m.symbol).catch(() => {});
    this.openCache.set(marketId, []);
  }

  /** 清理 Decibel 账户全部残留挂单（多次异常重启后） */
  async cancelAllAccountOrders(): Promise<number> {
    for (const id of this.tracked.keys()) this.cancelledIds.add(id);
    this.tracked.clear();
    const n = await this.dec.cancelAllOpenOrders().catch(() => 0);
    this.openCache.clear();
    return n;
  }

  getOpenOrders(marketId: number): GridOrder[] {
    return this.openCache.get(marketId) ?? [];
  }

  /** 看板用：直连 Decibel API 拉全账户挂单（与官网一致） */
  async getAllOpenOrdersLive(): Promise<
    {
      orderId: string;
      marketId: number;
      symbol: string;
      side: "buy" | "sell";
      price: number;
      sizeBase: number;
      levelIndex?: number;
    }[]
  > {
    const raw = await this.dec.getOpenOrders().catch(() => []);
    const out: {
      orderId: string;
      marketId: number;
      symbol: string;
      side: "buy" | "sell";
      price: number;
      sizeBase: number;
      levelIndex?: number;
    }[] = [];
    for (const o of raw) {
      const marketId = this.symbolToId.get(o.symbol.toUpperCase()) ?? 0;
      if (!marketId) continue;
      const gm = this.markets.get(marketId);
      const tr = this.tracked.get(o.orderId);
      out.push({
        orderId: o.orderId,
        marketId,
        symbol: gm?.displayName ?? o.symbol,
        side: o.isBuy ? "buy" : "sell",
        price: o.price,
        sizeBase: o.size,
        levelIndex: tr?.levelIndex,
      });
    }
    out.sort((a, b) => b.price - a.price);
    return out;
  }

  getTrackedOrderIds(runningMarketIds: number[]): string[] {
    const running = new Set(runningMarketIds);
    return [...this.tracked.entries()]
      .filter(([, tr]) => running.has(tr.marketId))
      .map(([id]) => id);
  }

  /** 撤销候选池外（如换标后残留的 LINK）+ 槽内 bot 未管的挂单 */
  async cancelUnmanagedOrders(
    managedIds: Set<string>,
    runningMarketIds: number[],
    allowedSymbols: string[] = []
  ): Promise<number> {
    const running = new Set(runningMarketIds);
    const allowed = new Set(allowedSymbols.map((s) => s.toUpperCase().replace(/-USD$/i, "")));
    const known = new Set([...managedIds, ...this.getTrackedOrderIds(runningMarketIds)]);
    const all = await this.getAllOpenOrdersLive();
    let offSlot = 0;
    let unmanaged = 0;
    for (const o of all) {
      const sym = o.symbol.replace(/-USD$/i, "").toUpperCase();
      const inPool = allowed.size === 0 || allowed.has(sym);
      if (!inPool) {
        await this.cancelOrder(o.marketId, o.orderId);
        offSlot++;
        continue;
      }
      if (!running.has(o.marketId)) {
        await this.cancelOrder(o.marketId, o.orderId);
        offSlot++;
        continue;
      }
      if (known.has(o.orderId)) continue;
      await this.cancelOrder(o.marketId, o.orderId);
      unmanaged++;
    }
    const total = offSlot + unmanaged;
    if (total > 0) {
      log.info(`[Grid/Decibel] 清理 stray 挂单 ${total} 笔（槽外 ${offSlot} + 槽内残留 ${unmanaged}）`);
    }
    return total;
  }

  getPosition(marketId: number): GridPosition | null {
    return this.positions.get(marketId) ?? null;
  }

  async closePosition(marketId: number): Promise<boolean> {
    const m = this.markets.get(marketId);
    if (!m) return false;
    const r = await this.dec.closePosition(m.symbol);
    return !!r.ok;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 暂停时停止轮询标的，避免撤单期间误判成交补单 */
  clearWatch(): void {
    this.watch.clear();
    this.fillGuard.clear();
    this.missingSince.clear();
  }

  /** 播种/重挂前调用：暂停该标的成交推断 */
  beginSeeding(marketId: number): void {
    this.fillGuard.add(marketId);
    this.missingSince.clear();
  }

  /** 播种/重挂后调用：grace 结束后恢复成交推断 */
  endSeeding(marketId: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        this.fillGuard.delete(marketId);
        resolve();
      }, this.seedGraceMs);
    });
  }

  private async refreshAccount(): Promise<void> {
    const [bal, stats] = await Promise.all([
      this.dec.getBalance().catch(() => null),
      this.dec.getAccountStats().catch(() => null),
    ]);
    if (bal) {
      this.equity = bal.equity;
      // Decibel 全仓占用时 available 可能为 0，舰队预算应按 equity 计算
      this.balance = bal.available > 0 ? bal.available : bal.equity;
    }
    if (stats) {
      this.equity = stats.equity;
      this.unrealisedPnl = stats.unrealizedPnl ?? null;
    }
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.refreshAccount().catch(() => {});
      await this.refreshAllPositions().catch(() => {});
      const now = Date.now();
      if (now - this.lastOfficialRefresh >= this.officialRefreshMs) {
        await this.refreshOfficialStats().catch(() => {});
        this.lastOfficialRefresh = now;
      }
      for (const marketId of this.watch) {
        const m = this.markets.get(marketId);
        if (!m) continue;
        const px = await this.getPrice(marketId).catch(() => this.prices.get(marketId) ?? m.lastPrice);
        this.emit("price", { marketId, price: px });

        const positions = await this.dec.getPositions().catch(() => []);
        const pos = positions.find((p) => p.symbol === m.symbol && p.size > 0);
        if (pos) {
          this.positions.set(marketId, {
            sizeBase: pos.side === "short" ? -pos.size : pos.size,
            entryPrice: pos.entryPrice,
            unrealizedPnl: pos.unrealizedPnl,
          });
        } else {
          this.positions.delete(marketId);
        }

        const openRaw = await this.dec.getOpenOrders(m.symbol).catch(() => null);
        let open = openRaw;
        const trackedHerePre = [...this.tracked.values()].filter((t) => t.marketId === marketId).length;
        if (open && open.length === 0 && trackedHerePre > 0) {
          for (let retry = 0; retry < 3; retry++) {
            await new Promise((r) => setTimeout(r, 800));
            open = await this.dec.getOpenOrders(m.symbol).catch(() => null);
            if (open && open.length > 0) break;
          }
        }
        if (!open) continue;
        if (this.fillGuard.has(marketId)) {
          this.openCache.set(marketId, []);
          continue;
        }

        // clientOrderId 对齐：place 返回的 orderId 可能与 open API 不一致
        for (const o of open) {
          const cid = o.clientId?.trim();
          if (!cid) continue;
          for (const [tid, tr] of [...this.tracked.entries()]) {
            if (tr.marketId !== marketId || tr.clientOrderId !== cid || tid === o.orderId) continue;
            log.warn(`[Grid/Decibel] orderId remap ${tid.slice(0, 8)}… → ${o.orderId.slice(0, 8)}… (${m.symbol})`);
            this.tracked.delete(tid);
            this.missingSince.delete(tid);
            this.tracked.set(o.orderId, { ...tr, clientOrderId: cid });
          }
        }

        const trackedHere = [...this.tracked.values()].filter((t) => t.marketId === marketId).length;
        const openIds = new Set(open.map((o) => o.orderId));

        // API 偶发返回空列表 → 跳过（勿把内存当链上）
        if (open.length === 0 && trackedHere > 0) continue;

        const gridOrders: GridOrder[] = open.map((o) => {
          const tr = this.tracked.get(o.orderId);
          return {
            orderId: o.orderId,
            marketId,
            side: o.isBuy ? "buy" : "sell",
            price: o.price,
            sizeBase: o.size,
            reduceOnly: o.reduceOnly,
            levelIndex: tr?.levelIndex,
            clientOrderId: o.clientId,
          };
        });
        this.openCache.set(marketId, gridOrders);
        this.emit("openSync", { marketId, orders: gridOrders });

        const nowMs = Date.now();
        // 链上已无、内存仍追踪的 ghost 单：静默剔除，不触发补单
        if (open.length > 0) {
          for (const [orderId, tr] of [...this.tracked.entries()]) {
            if (tr.marketId !== marketId || openIds.has(orderId)) continue;
            if (nowMs - tr.placedAt < this.minOrderAgeMs) continue;
            if (this.missingSince.has(orderId)) continue;
            this.tracked.delete(orderId);
            this.missingSince.delete(orderId);
          }
        }

        // 成交推断：API 列表明显不全时跳过，但 openSync 已更新看板
        let skipFills = false;
        if (trackedHere >= 3 && open.length > 0) {
          let matched = 0;
          for (const [oid, tr] of this.tracked.entries()) {
            if (tr.marketId === marketId && openIds.has(oid)) matched++;
          }
          if (matched / trackedHere < 0.5) skipFills = true;
        }
        if (skipFills) continue;

        for (const [orderId, tr] of [...this.tracked.entries()]) {
          if (tr.marketId !== marketId) continue;
          if (openIds.has(orderId)) {
            this.missingSince.delete(orderId);
            continue;
          }
          if (nowMs - tr.placedAt < this.minOrderAgeMs) continue;

          const since = this.missingSince.get(orderId);
          if (since == null) {
            this.missingSince.set(orderId, nowMs);
            continue;
          }
          if (nowMs - since < this.fillConfirmMs) continue;

          this.tracked.delete(orderId);
          this.missingSince.delete(orderId);
          if (this.cancelledIds.delete(orderId)) continue;

          const fill: GridFill = {
            orderId,
            marketId,
            side: tr.side,
            price: tr.price,
            sizeBase: tr.sizeBase,
            levelIndex: tr.levelIndex,
            clientOrderId: tr.clientOrderId,
          };
          this.emit("fill", fill);
        }
      }
    } catch {
      /* API 偶发失败，跳过本轮 poll */
    } finally {
      this.busy = false;
    }
  }
}
