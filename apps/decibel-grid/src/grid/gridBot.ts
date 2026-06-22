import {
  buildGrid,
  CLOSE_COVER_RATIO,
  isClosingFill,
  replacementFor,
  resolveReduceOnly,
  seedOrders,
  shouldAllowOpenSide,
  type GridMode,
} from "./gridCore.js";
import type { GridExchangeAdapter } from "./iExchange.js";
import type { GridJournal } from "./gridJournal.js";

export interface BotConfig {
  marketId: number;
  symbol?: string;
  displayName?: string;
  mode?: GridMode;
  lower: number;
  upper: number;
  gridCount: number;
  sizeBase: number;
  leverage?: number;
  autoStopOutOfRange?: boolean;
  autoRecenter?: boolean;
  rangeHalfPct?: number;
  recenterCooldownMs?: number;
  skipBand?: number;
  onBreakRange?: "recenter" | "shiftGrid";
  /** 近端铺单比例（趋势市 0.4 = 只铺 40% 近价格） */
  nearSeedRatio?: number;
  stepSize?: number;
  stepPrice?: number;
}

export class GridBot {
  private ex: GridExchangeAdapter;
  private journal: GridJournal | null;
  running = false;
  config: BotConfig | null = null;
  grid: ReturnType<typeof buildGrid> | null = null;
  private active = new Map<string, { levelIndex: number; side: "buy" | "sell"; price: number }>();
  fills: Record<string, unknown>[] = [];
  alerts: { t: number; message: string }[] = [];
  stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
  startBalance: number | null = null;
  lastPrice: number | null = null;
  outOfRange = false;
  outOfRangeSince: number | null = null;
  stoppedAt: number | null = null;
  lastRecenterAt: number | null = null;
  risk: Record<string, number> | null = null;
  private _recentering = false;
  private _recenterTimestamps: number[] = [];
  private readonly maxRecentersPerHour = 6;
  private _onFill = (f: {
    orderId: string;
    marketId: number;
    side: "buy" | "sell";
    price: number;
    sizeBase: number;
    levelIndex?: number;
  }) => this.handleFill(f);
  private _onPrice = (p: { marketId: number; price: number }) => this.handlePrice(p);
  private _onOpenSync = (p: { marketId: number; orders: { orderId: string; side: "buy" | "sell"; price: number; levelIndex?: number }[] }) =>
    this.handleOpenSync(p);

  constructor(exchange: GridExchangeAdapter, journal: GridJournal | null = null) {
    this.ex = exchange;
    this.journal = journal;
  }

  async start(cfg: BotConfig) {
    if (this.running) throw new Error(`${this.config?.displayName || "该标的"} 已在运行`);
    const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
    if (!market) throw new Error(`找不到 marketId=${cfg.marketId}`);

    const leverage = Math.min(Number(cfg.leverage || 3), market.maxLeverage || 50);
    const sizeBase = Math.max(Number(cfg.sizeBase), market.minOrderSize || 0);
    this.config = {
      marketId: market.marketId,
      symbol: market.symbol,
      displayName: market.displayName,
      mode: cfg.mode || "neutral",
      lower: Number(cfg.lower),
      upper: Number(cfg.upper),
      gridCount: Number(cfg.gridCount),
      sizeBase,
      leverage,
      autoStopOutOfRange: cfg.autoStopOutOfRange === true,
      autoRecenter: cfg.autoRecenter !== false,
      rangeHalfPct: cfg.rangeHalfPct ?? 0.035,
      recenterCooldownMs: cfg.recenterCooldownMs ?? 30 * 60 * 1000,
      skipBand: cfg.skipBand ?? 0.1,
      stepSize: market.stepSize,
      stepPrice: market.stepPrice,
      onBreakRange: cfg.onBreakRange ?? "shiftGrid",
      nearSeedRatio: cfg.nearSeedRatio ?? 1,
    };
    this.grid = buildGrid({
      lower: this.config.lower,
      upper: this.config.upper,
      gridCount: this.config.gridCount,
    });

    const mid = (this.config.lower + this.config.upper) / 2;
    const notional = this.grid.count * sizeBase * mid;
    this.risk = {
      leverage,
      notional: round2(notional),
      requiredMargin: round2(notional / leverage),
      perRungProfit: round2(this.grid.spacing * sizeBase),
      orderNotionalUsd: round2(sizeBase * mid),
      spacingPct: round2((this.grid.spacing / mid) * 100),
    };

    await this.ex.cancelAll(market.marketId).catch((e) => {
      this.alert(`撤单失败: ${e?.message ?? e}`);
    });
    try {
      await this.ex.setLeverage(market.marketId, leverage);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("ECANNOT_MODIFY_SETTINGS_WHILE_HOLDING_POSITION")) {
        const ex = this.ex as GridExchangeAdapter & {
          getCurrentLeverage?: (marketId: number) => Promise<number | null>;
        };
        const cur = await ex.getCurrentLeverage?.(market.marketId).catch(() => null);
        if (cur != null && cur === leverage) {
          this.alert(`有持仓，链上已是 ${leverage}x，继续铺网格`);
        } else {
          this.alert(`有持仓无法改杠杆为 ${leverage}x（链上 ${cur ?? "?"}x）`);
          throw e;
        }
      } else {
        this.alert(`杠杆设置 ${leverage}x 失败: ${msg.slice(0, 100)}`);
        throw e;
      }
    }

    this.lastPrice = await this.ex.getPrice(market.marketId);
    this.outOfRange = this.lastPrice < this.config.lower || this.lastPrice > this.config.upper;
    this.outOfRangeSince = this.outOfRange ? Date.now() : null;
    this.stoppedAt = null;

    this.ex.on("fill", this._onFill);
    this.ex.on("price", this._onPrice);
    this.ex.on("openSync", this._onOpenSync);

    const exSeed = this.ex as GridExchangeAdapter & {
      beginSeeding?: (id: number) => void;
      endSeeding?: (id: number) => Promise<void>;
    };
    exSeed.beginSeeding?.(market.marketId);
    try {
      await this.seedAround(this.lastPrice);
    } finally {
      await exSeed.endSeeding?.(market.marketId);
    }
    await new Promise((r) => setTimeout(r, 8000));
    this.syncActiveFromExchange();

    if (this.startBalance == null && typeof this.ex.balance === "number") {
      this.startBalance = this.ex.balance;
    }
    this.running = true;
    this.alert(
      `已启动 ${this.config.displayName} ${labelMode(this.config.mode!)}，${this.grid.count} 格，间距 ${this.grid.spacing}，杠杆 ${leverage}x`
    );
    return this.getState();
  }

  private async seedAround(price: number, opts: { nearOnly?: boolean } = {}) {
    if (!this.config || !this.grid) return;
    const pos = this.positionSigned();
    const mode = this.config.mode || "neutral";
    let seeds = seedOrders({
      levels: this.grid.levels,
      price,
      mode,
      spacing: this.grid.spacing,
      skipBand: this.config.skipBand,
    });
    const ratio = opts.nearOnly ? (this.config.nearSeedRatio ?? 0.4) : (this.config.nearSeedRatio ?? 1);
    if (ratio < 1 && seeds.length > 4) {
      seeds = [...seeds]
        .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
        .slice(0, Math.max(4, Math.ceil(seeds.length * ratio)));
    }
    for (const s of seeds) {
      if (!shouldAllowOpenSide(s.side, mode, pos, this.config.sizeBase)) continue;
      await this.place(s);
    }
    await this.replenishCloseOrders(price);
  }

  /** DGT：价破区间后以现价为新中心移框，不清仓 */
  async shiftGrid(price?: number): Promise<boolean> {
    return this.recenter(price, { force: true, shift: true });
  }

  async recenter(price?: number, opts: { force?: boolean; shift?: boolean } = {}): Promise<boolean> {
    if (!this.running || this._recentering || !this.config) return false;
    const px = Number(price ?? this.lastPrice);
    if (!(px > 0)) return false;
    const now = Date.now();
    if (opts.force) {
      this._recenterTimestamps = this._recenterTimestamps.filter((t) => now - t < 3600_000);
      if (this._recenterTimestamps.length >= this.maxRecentersPerHour) {
        this.alert("重挂熔断：1h 内 recenter 次数过多");
        return false;
      }
    }
    if (!opts.force && this.lastRecenterAt && now - this.lastRecenterAt < this.config.recenterCooldownMs!) {
      return false;
    }

    this._recentering = true;
    try {
      const exSeed = this.ex as GridExchangeAdapter & {
        beginSeeding?: (id: number) => void;
        endSeeding?: (id: number) => Promise<void>;
      };
      exSeed.beginSeeding?.(this.config.marketId);
      await this.ex.cancelAll(this.config.marketId).catch(() => {});
      this.active.clear();

      const half = this.config.rangeHalfPct ?? 0.035;
      const stepP = Number(this.config.stepPrice) || 0.01;
      const lower = snapPx(px * (1 - half), stepP);
      const upper = snapPx(px * (1 + half), stepP);
      this.config.lower = lower;
      this.config.upper = upper;
      this.grid = buildGrid({ lower, upper, gridCount: this.config.gridCount });

      const mid = (lower + upper) / 2;
      this.risk = {
        ...this.risk!,
        perRungProfit: round2(this.grid.spacing * this.config.sizeBase),
        spacingPct: round2((this.grid.spacing / mid) * 100),
      };

      this.lastPrice = px;
      this.outOfRange = false;
      this.outOfRangeSince = null;
      this.lastRecenterAt = now;
      if (opts.force) this._recenterTimestamps.push(now);
      await this.seedAround(px);
      await exSeed.endSeeding?.(this.config.marketId);
      this.syncActiveFromExchange();
      if (this.active.size < 3) {
        await new Promise((r) => setTimeout(r, 4000));
        await this.seedAround(px);
        await exSeed.endSeeding?.(this.config.marketId);
        this.syncActiveFromExchange();
      }
      this.alert(
        opts.shift
          ? `⇄ DGT 移框 ${round2(px)} 为中心，${this.active.size} 单`
          : `↻ 已以 ${round2(px)} 为中心重挂网格，${this.active.size} 单`
      );
      return true;
    } finally {
      this._recentering = false;
    }
  }

  private positionSigned(): number {
    if (!this.config) return 0;
    return this.ex.getPosition(this.config.marketId)?.sizeBase ?? 0;
  }

  private hungSizeOnSide(side: "buy" | "sell"): number {
    if (!this.config) return 0;
    let sum = 0;
    for (const o of this.ex.getOpenOrders(this.config.marketId)) {
      if (o.side === side) sum += o.sizeBase;
    }
    return sum;
  }

  /** 按持仓缺口补平仓侧挂单（≥70% 持仓），不按「已有 1 单就停」 */
  private async replenishCloseOrders(price: number): Promise<void> {
    if (!this.config || !this.grid) return;
    const pos = this.positionSigned();
    const mode = this.config.mode || "neutral";
    const sizeBase = this.config.sizeBase;
    const need = Math.abs(pos);
    if (need < sizeBase * 0.15) return;

    const closeSide: "buy" | "sell" = pos < 0 ? "buy" : "sell";
    const target = need * CLOSE_COVER_RATIO;
    let gap = target - this.hungSizeOnSide(closeSide);
    if (gap < sizeBase * 0.1) return;

    const seeds = seedOrders({
      levels: this.grid.levels,
      price,
      mode,
      spacing: this.grid.spacing,
      skipBand: this.config.skipBand,
    })
      .filter((s) => s.side === closeSide)
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));

    for (const s of seeds) {
      if (gap < sizeBase * 0.1) break;
      if (this.active.size >= this.maxOpenOrders()) break;
      await this.place({ ...s, reduceOnly: true });
      gap -= sizeBase;
    }
  }

  private maxOpenOrders(): number {
    if (!this.grid) return 48;
    return this.grid.count + 4;
  }

  private hasLevelSide(levelIndex: number, side: "buy" | "sell"): boolean {
    if (levelIndex < 0 || !this.grid) return false;
    const lvlPx = this.grid.levels[levelIndex];
    const tick = this.config?.stepPrice ?? 0.01;
    const matches = (o: { levelIndex: number; side: string; price: number }) => {
      if (o.side !== side) return false;
      if (o.levelIndex === levelIndex) return true;
      return lvlPx != null && Math.abs(o.price - lvlPx) <= tick;
    };
    for (const o of this.active.values()) {
      if (matches(o)) return true;
    }
    if (this.config) {
      for (const o of this.ex.getOpenOrders(this.config.marketId)) {
        if (matches({ levelIndex: o.levelIndex ?? -1, side: o.side, price: o.price })) return true;
      }
    }
    return false;
  }

  /** 用交易所 open 列表校正 bot 内存（含 levelIndex 缺失的单） */
  private syncActiveFromExchange(): void {
    if (!this.config) return;
    const open = this.ex.getOpenOrders(this.config.marketId);
    this.active.clear();
    for (const o of open) {
      this.active.set(o.orderId, {
        levelIndex: o.levelIndex ?? -1,
        side: o.side,
        price: o.price,
      });
    }
  }

  private handleOpenSync(p: {
    marketId: number;
    orders: { orderId: string; side: "buy" | "sell"; price: number; levelIndex?: number }[];
  }) {
    if (!this.running || !this.config || p.marketId !== this.config.marketId) return;
    this.active.clear();
    for (const o of p.orders) {
      this.active.set(o.orderId, {
        levelIndex: o.levelIndex ?? -1,
        side: o.side,
        price: o.price,
      });
    }
  }

  getManagedOrderIds(): string[] {
    return [...this.active.keys()];
  }

  /** 现价脱离挂单区（典型空转：例如净空后只剩下方买单、价格浮在上方） */
  isOrdersDetachedFromPrice(price?: number): boolean {
    if (!this.config || !this.grid || !this.running) return false;
    const px = Number(price ?? this.lastPrice);
    if (!(px > 0)) return false;
    const open = this.ex.getOpenOrders(this.config.marketId);
    const minOo = Math.max(6, Math.ceil(this.grid.count * 0.35));
    if (open.length < minOo) return false;
    if (!open.length) return true;
    const spacing = this.grid.spacing;
    const margin = spacing * (1 + (this.config.skipBand ?? 0.1));
    const buys = open.filter((o) => o.side === "buy");
    const sells = open.filter((o) => o.side === "sell");
    if (buys.length && !sells.length) {
      return px > Math.max(...buys.map((o) => o.price)) + margin;
    }
    if (sells.length && !buys.length) {
      return px < Math.min(...sells.map((o) => o.price)) - margin;
    }
    if (buys.length && sells.length) {
      const maxBuy = Math.max(...buys.map((o) => o.price));
      const minSell = Math.min(...sells.map((o) => o.price));
      if (px > minSell + margin && px > maxBuy + margin) return true;
      if (px < maxBuy - margin && px < minSell - margin) return true;
    }
    return false;
  }

  /** 检测脱离并强制居中重挂，避免「有单但不成交」空转 */
  async ensureGridNearPrice(): Promise<boolean> {
    if (!this.running || !this.config || this.outOfRange || this._recentering) return false;
    const open = this.ex.getOpenOrders(this.config.marketId);
    const gridCount = this.grid?.count ?? this.config.gridCount ?? 0;
    const minOo = Math.max(6, Math.ceil(gridCount * 0.35));
    if (open.length < minOo) return false;
    const px = this.lastPrice ?? (await this.ex.getPrice(this.config.marketId));
    if (!this.isOrdersDetachedFromPrice(px)) return false;
    this.alert(`现价 ${round2(px)} 脱离挂单区，强制居中重挂`);
    return await this.recenter(px, { force: true });
  }

  /** 维护周期：仅补平仓侧缺口（不全量重铺） */
  async replenishMaintain(): Promise<void> {
    if (!this.running || !this.config || !this.grid || this.outOfRange) return;
    const px = this.lastPrice ?? (await this.ex.getPrice(this.config.marketId));
    if (!(px > 0)) return;
    await this.replenishCloseOrders(px);
  }

  /** 运行中补铺：常规网格 + 持仓缺口平仓单 */
  async replenishIfEmpty(): Promise<void> {
    if (!this.running || !this.config || !this.grid || this.outOfRange) return;
    const open = this.ex.getOpenOrders(this.config.marketId);
    if (open.length >= this.maxOpenOrders()) return;
    const px = this.lastPrice ?? (await this.ex.getPrice(this.config.marketId));
    if (!(px > 0)) return;
    await this.seedAround(px);
    await new Promise((r) => setTimeout(r, 3000));
    this.syncActiveFromExchange();
    this.alert(`补铺网格 ${this.active.size} 单（现价 ${round2(px)}）`);
  }

  async stop(opts: { closePosition?: boolean } = {}) {
    if (!this.running || !this.config) return this.getState();
    this.ex.off("fill", this._onFill);
    this.ex.off("price", this._onPrice);
    this.ex.off("openSync", this._onOpenSync);
    await this.ex.cancelAll(this.config.marketId).catch(() => {});
    this.active.clear();
    let closed = false;
    if (opts.closePosition) {
      closed = await this.ex.closePosition(this.config.marketId).catch(() => false);
    }
    this.running = false;
    this.stoppedAt = Date.now();
    this.alert(opts.closePosition && closed ? "机器人已停止并提交平仓" : "机器人已停止，挂单已撤销");
    return this.getState();
  }

  private async place(o: { levelIndex: number; side: "buy" | "sell"; price: number; reduceOnly?: boolean }) {
    if (!this.config) return;
    if (this.active.size >= this.maxOpenOrders()) return;
    if (this.hasLevelSide(o.levelIndex, o.side)) return;

    const pos = this.positionSigned();
    const mode = this.config.mode || "neutral";
    if (!shouldAllowOpenSide(o.side, mode, pos, this.config.sizeBase)) return;

    const reduceOnly = o.reduceOnly ?? resolveReduceOnly(o.side, mode, pos);
    const clientOrderId = Number(`${o.levelIndex}${o.side === "buy" ? 0 : 1}${Date.now() % 100000}`);
    const r = await this.ex
      .placeLimitOrder({
        marketId: this.config.marketId,
        side: o.side,
        price: o.price,
        sizeBase: this.config.sizeBase,
        reduceOnly,
        levelIndex: o.levelIndex,
        clientOrderId,
      })
      .catch((e: Error) => {
        this.alert(`下单失败: ${e.message}`);
        return null;
      });
    if (r?.orderId) {
      this.active.set(r.orderId, { levelIndex: o.levelIndex, side: o.side, price: o.price });
    }
  }

  private handleFill(f: {
    orderId: string;
    marketId: number;
    side: "buy" | "sell";
    price: number;
    sizeBase: number;
    levelIndex?: number;
  }) {
    if (!this.running || !this.config || !this.grid || f.marketId !== this.config.marketId) return;
    this.active.delete(f.orderId);
    if (f.side === "buy") this.stats.buys++;
    else this.stats.sells++;
    this.stats.volume = round2(this.stats.volume + f.price * f.sizeBase);
    this.fills.unshift({
      t: Date.now(),
      side: f.side,
      price: f.price,
      size: f.sizeBase,
      level: f.levelIndex,
      symbol: this.config.displayName,
      marketId: this.config.marketId,
    });
    if (this.fills.length > 50) this.fills.pop();

    const posNow = this.positionSigned();
    const posBefore = f.side === "buy" ? posNow - f.sizeBase : posNow + f.sizeBase;
    const mode = this.config.mode || "neutral";
    const closing = isClosingFill(f.side, mode, posBefore);
    let gridProfitDelta = 0;
    if (closing) {
      this.stats.completedRungs++;
      gridProfitDelta = this.grid.spacing * this.config.sizeBase;
      this.stats.gridProfit = round2(this.stats.completedRungs * this.grid.spacing * this.config.sizeBase);
    }

    this.journal?.recordFill({
      orderId: f.orderId,
      marketId: this.config.marketId,
      symbol: this.config.displayName,
      side: f.side,
      price: f.price,
      sizeBase: f.sizeBase,
      levelIndex: f.levelIndex,
      completedRung: closing,
      gridProfitDelta: round2(gridProfitDelta),
    });

    const repl = replacementFor(
      { side: f.side, levelIndex: f.levelIndex ?? 0 },
      this.grid.levels,
      this.config.mode || "neutral"
    );
    if (repl && !this.outOfRange && !this.hasLevelSide(repl.levelIndex, repl.side)) {
      const posAfter = this.positionSigned();
      if (shouldAllowOpenSide(repl.side, mode, posAfter, this.config.sizeBase)) {
        void this.place(repl);
      }
    }
    void this.replenishCloseOrders(this.lastPrice ?? f.price);
  }

  private handlePrice(p: { marketId: number; price: number }) {
    if (!this.config || p.marketId !== this.config.marketId || !this.running) return;
    this.lastPrice = p.price;
    const out = p.price < this.config.lower || p.price > this.config.upper;

    if (out && !this.outOfRange) {
      this.outOfRange = true;
      this.outOfRangeSince = Date.now();
      if (this.config.autoRecenter) {
        const fn =
          this.config.onBreakRange === "shiftGrid"
            ? () => this.shiftGrid(p.price)
            : () => this.recenter(p.price, { force: true });
        void fn().catch((e) => this.alert(`重挂失败: ${e.message}`));
      } else if (this.config.autoStopOutOfRange) {
        void this.stop({ closePosition: true });
      } else {
        this.alert(`价格越界（${round2(p.price)}），暂停区间外补单`);
      }
    } else if (out && this.outOfRange && this.config.autoRecenter) {
      if (this.lastRecenterAt && Date.now() - this.lastRecenterAt >= this.config.recenterCooldownMs!) {
        const fn =
          this.config.onBreakRange === "shiftGrid"
            ? () => this.shiftGrid(p.price)
            : () => this.recenter(p.price);
        void fn().catch(() => {});
      }
    } else if (!out && this.outOfRange) {
      this.outOfRange = false;
      this.outOfRangeSince = null;
      this.alert(`价格回到区间内（${round2(p.price)}）`);
    }
  }

  private alert(message: string) {
    const text = message.length > 160 ? message.slice(0, 160) + "…" : message;
    if (this.alerts[0]?.message === text) return;
    this.alerts.unshift({ t: Date.now(), message: text });
    if (this.alerts.length > 30) this.alerts.pop();
    if (this.config?.marketId) {
      this.journal?.recordAlert({
        marketId: this.config.marketId,
        symbol: this.config.displayName,
        message,
      });
    }
  }

  getState() {
    const pos = this.config ? this.ex.getPosition(this.config.marketId) : null;
    const chainOpen = this.config ? this.ex.getOpenOrders(this.config.marketId) : [];
    const last = this.lastPrice ?? 0;
    const validOpen =
      last > 0
        ? chainOpen.filter((o) => o.price > last * 0.05 && o.price < last * 20)
        : chainOpen.filter((o) => o.price > 0);
    const openByLevel: Record<number, string> = {};
    const openOrdersList: Record<string, unknown>[] = [];
    const orderSource = validOpen.length > 0 ? validOpen : null;
    if (orderSource) {
      for (const o of orderSource) {
        if (o.levelIndex != null && o.levelIndex >= 0) openByLevel[o.levelIndex] = o.side;
        openOrdersList.push({
          orderId: String(o.orderId),
          levelIndex: o.levelIndex,
          side: o.side,
          price: round2(o.price),
        });
      }
    } else {
      for (const [orderId, o] of this.active.entries()) {
        openByLevel[o.levelIndex] = o.side;
        openOrdersList.push({
          orderId: String(orderId),
          levelIndex: o.levelIndex,
          side: o.side,
          price: round2(o.price),
        });
      }
    }
    openOrdersList.sort((a, b) => Number(b.price) - Number(a.price));
    const openOrders = orderSource ? orderSource.length : this.active.size;
    const unrealized = pos ? round2(pos.unrealizedPnl) : 0;
    const balance = typeof this.ex.balance === "number" ? round2(this.ex.balance) : null;
    const totalPnl = round2(this.stats.gridProfit + unrealized);
    const equity = balance != null ? round2(balance + unrealized) : null;
    const displayStats =
      this.journal && this.config?.marketId
        ? this.journal.getMarketStats(this.config.marketId)
        : this.stats;
    return {
      mode: this.ex.mode,
      running: this.running,
      config: this.config,
      grid: this.grid,
      lastPrice: this.lastPrice != null ? round2(this.lastPrice) : null,
      outOfRange: this.outOfRange,
      outOfRangeSince: this.outOfRangeSince,
      lastRecenterAt: this.lastRecenterAt,
      stoppedAt: this.stoppedAt,
      risk: this.risk,
      stats: displayStats,
      openOrders,
      botOpenOrders: this.active.size,
      activeOrderIds: [...this.active.keys()],
      openOrdersList,
      openByLevel,
      position: pos
        ? {
            sizeBase: round6(pos.sizeBase),
            entryPrice: round2(pos.entryPrice),
            unrealizedPnl: round2(pos.unrealizedPnl),
            leverage: pos.leverage ?? null,
          }
        : null,
      realizedPnl: this.stats.gridProfit,
      unrealizedPnl: unrealized,
      totalPnl,
      equity,
      balance,
      volume: this.stats.volume,
      startBalance: this.startBalance != null ? round2(this.startBalance) : null,
      fills: this.fills.slice(0, 20),
      alerts: this.alerts.slice(0, 12),
    };
  }
}

function labelMode(m: GridMode): string {
  return m === "long" ? "做多网格" : m === "short" ? "做空网格" : "中性网格";
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
function snapPx(px: number, step: number): number {
  const s = Number(step) || 0.01;
  return Math.round(Math.round(px / s) * s * 100) / 100;
}
