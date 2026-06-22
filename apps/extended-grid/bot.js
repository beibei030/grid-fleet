// GridBot: orchestrates an arithmetic grid on one market. Places the initial
// ladder of limit orders, and on every fill places the opposite order one rung
// away (buy->sell up, sell->buy down), capturing `spacing * size` per round.
// Out-of-range: recenter grid around price (default) instead of auto-stop.
import { buildGrid, seedOrders, replacementFor, isReduceOnly } from './grid.js';

const SELL_COVERAGE_TARGET = 0.7;
const MAX_LONG_GRID_MULT = 0.5;
const MAX_SHORT_GRID_MULT = 0.5;

export class GridBot {
  constructor(exchange, journal = null) {
    this.ex = exchange;
    this.journal = journal;
    this.running = false;
    this.config = null;
    this.grid = null;
    this.active = new Map();
    this.fills = [];
    this.alerts = [];
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.startBalance = null;
    this.lastPrice = null;
    this.outOfRange = false;
    this.outOfRangeSince = null;
    this.stoppedAt = null;
    this.lastRecenterAt = null;
    this._recentering = false;
    this._seeding = false;
    this._placing = new Set();
    this._onFill = (f) => this._handleFill(f);
    this._onPrice = (p) => this._handlePrice(p);
    this._onCancel = (c) => this._handleCancel(c);
  }

  /** @param cfg bot + fleet plan fields */
  async start(cfg) {
    if (this.running) throw new Error(`${this.config?.displayName || '该标的'} 已在运行，请先停止此标的。`);
    const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
    if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);

    const leverage = Math.min(Number(cfg.leverage || 3), market.maxLeverage || 50);
    const sizeBase = Math.max(Number(cfg.sizeBase), market.minOrderSize || 0);
    this.config = {
      marketId: market.marketId,
      displayName: market.displayName,
      mode: cfg.mode || 'neutral',
      lower: Number(cfg.lower),
      upper: Number(cfg.upper),
      gridCount: Number(cfg.gridCount),
      sizeBase,
      leverage,
      autoStopOutOfRange: cfg.autoStopOutOfRange === true || cfg.autoStopOutOfRange === 'true',
      autoRecenter: !(cfg.autoRecenter === false || cfg.autoRecenter === 'false'),
      rangeHalfPct: cfg.rangeHalfPct != null ? Number(cfg.rangeHalfPct) : 0.035,
      recenterCooldownMs: cfg.recenterCooldownMs != null ? Number(cfg.recenterCooldownMs) : 30 * 60 * 1000,
      onBreakRange: cfg.onBreakRange || 'shiftGrid',
      skipBand: cfg.skipBand != null ? Number(cfg.skipBand) : 0.10,
      stepSize: market.stepSize,
      stepPrice: market.stepPrice,
    };
    this._rebuildGrid(this.config.lower, this.config.upper);

    await this.ex.setLeverage(market.marketId, leverage).catch(() => {});
    await this.ex.cancelAll(market.marketId).catch(() => {});

    this.lastPrice = await this.ex.getPrice(market.marketId);
    this.outOfRange = this.lastPrice < this.config.lower || this.lastPrice > this.config.upper;
    this.outOfRangeSince = this.outOfRange ? Date.now() : null;
    this.stoppedAt = null;

    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    this.ex.on('cancel', this._onCancel);
    if (typeof this.ex.start === 'function') this.ex.start();

    await this._seedAround(this.lastPrice);

    if (this.startBalance == null && typeof this.ex.balance === 'number') this.startBalance = this.ex.balance;
    const pos0 = this.ex.getPosition?.(market.marketId);
    this.startUnrealized = pos0 ? round2(pos0.unrealizedPnl) : 0;
    this.startedAt = Date.now();
    this.running = true;
    const inv = this._inventorySnapshot();
    this._alert(`已启动 ${this.config.displayName} ${labelMode(this.config.mode)}，${this.grid.count} 格，间距 ${this.grid.spacing}（${this.risk.spacingPct}%），杠杆 ${leverage}x，区间 ${this.config.lower}~${this.config.upper}，挂出 ${this._liveOpenOrders().length} 单，${this._coverSummary(inv)}。`);
    return this.getState();
  }

  _rebuildGrid(lower, upper) {
    this.grid = buildGrid({
      lower,
      upper,
      gridCount: this.config.gridCount,
      priceStep: this.config.stepPrice,
    });
    this.config.lower = this.grid.levels[0];
    this.config.upper = this.grid.levels[this.grid.levels.length - 1];
    const mid = (this.config.lower + this.config.upper) / 2;
    const notional = this.grid.count * this.config.sizeBase * mid;
    this.risk = {
      leverage: this.config.leverage,
      notional: round2(notional),
      requiredMargin: round2(notional / this.config.leverage),
      perRungProfit: round2(this.grid.spacing * this.config.sizeBase),
      spacingPct: round2((this.grid.spacing / mid) * 100),
    };
  }

  async _seedAround(price) {
    this._seeding = true;
    try {
    const seeds = seedOrders({
      levels: this.grid.levels,
      price,
      mode: this.config.mode,
      spacing: this.grid.spacing,
      skipBand: this.config.skipBand,
    });
    for (const s of seeds) {
      if (s.side === 'buy' && !this._shouldAllowNewBuy()) continue;
      if (s.side === 'sell' && !this._shouldAllowNewSell()) continue;
      await this._place(s);
    }
    await this.rebalanceInventory(price);
    } finally {
      this._seeding = false;
    }
  }

  /** 库存补挂 + 去重（维护任务也会调用） */
  async rebalanceInventory(price) {
    await this._rebalanceSells(price);
    await this._rebalanceBuys(price);
    await this._dedupeLiveOrders();
  }

  /** 最近挂单距现价 %（维护任务用于检测空转） */
  nearestOrderDistancePct() {
    const px = Number(this.lastPrice);
    if (!(px > 0) || !this.running) return null;
    const live = this._liveOpenOrders();
    if (!live.length) return null;
    let min = Infinity;
    for (const o of live) min = Math.min(min, Math.abs(o.price - px) / px * 100);
    return min === Infinity ? null : Math.round(min * 1000) / 1000;
  }

  /** 以现价为中心重挂网格（越界时不停止） */
  async recenter(price, { force = false } = {}) {
    if (!this.running || this._recentering) return false;
    const px = Number(price ?? this.lastPrice);
    if (!(px > 0)) return false;
    const now = Date.now();
    if (!force && this.lastRecenterAt && now - this.lastRecenterAt < this.config.recenterCooldownMs) {
      return false;
    }

    this._recentering = true;
    try {
      await this.ex.cancelAll(this.config.marketId).catch(() => {});
      this.active.clear();

      const half = this.config.rangeHalfPct;
      const stepP = Number(this.config.stepPrice) || 0.01;
      const lower = snapPx(px * (1 - half), stepP);
      const upper = snapPx(px * (1 + half), stepP);
      this._rebuildGrid(lower, upper);

      this.lastPrice = px;
      this.outOfRange = false;
      this.outOfRangeSince = null;
      this.lastRecenterAt = now;
      await this._seedAround(px);
      const inv = this._inventorySnapshot();
      this._alert(`↻ 已以 ${round2(px)} 为中心重挂网格（±${(half * 100).toFixed(1)}%），${this.config.lower}~${this.config.upper}，${this._liveOpenOrders().length} 单，${this._coverSummary(inv)}。`);
      return true;
    } finally {
      this._recentering = false;
    }
  }

  async stop({ closePosition = false } = {}) {
    if (!this.running) return this.getState();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    this.ex.off('cancel', this._onCancel);
    await this.ex.cancelAll(this.config.marketId).catch(() => {});
    this.active.clear();
    let closed = false;
    if (closePosition && typeof this.ex.closePosition === 'function') {
      closed = await this.ex.closePosition(this.config.marketId)
        .then(() => true)
        .catch((e) => { this._alert('⚠️ 平仓下单失败: ' + e.message); return false; });
    }
    this.running = false;
    this.stoppedAt = Date.now();
    this._alert(closePosition && closed ? '机器人已停止：挂单已撤销，已提交市价平仓单。' : '机器人已停止，挂单已撤销。');
    return this.getState();
  }

  _inventorySnapshot() {
    const pos = this.ex.getPosition?.(this.config.marketId);
    const signed = pos?.sizeBase ?? 0;
    const longSize = signed > 0 ? signed : 0;
    const shortSize = signed < 0 ? Math.abs(signed) : 0;
    const live = this._liveOpenOrders();
    let sellQueued = 0;
    let buyQueued = 0;
    for (const o of live) {
      const sz = Number(o.sizeBase ?? this.config.sizeBase ?? 0);
      if (o.side === 'sell' && o.reduceOnly) sellQueued += sz;
      if (o.side === 'buy' && o.reduceOnly) buyQueued += sz;
    }
    return {
      signed,
      longSize,
      shortSize,
      sellQueued,
      buyQueued,
      buyOrders: live.filter((o) => o.side === 'buy').length,
      sellOrders: live.filter((o) => o.side === 'sell').length,
    };
  }

  _coverPct(queued, size) {
    if (!size) return 100;
    return Math.round((queued / size) * 1000) / 10;
  }

  _coverSummary(inv) {
    if (inv.longSize > 0) return `卖单覆盖 ${this._coverPct(inv.sellQueued, inv.longSize)}%`;
    if (inv.shortSize > 0) return `买单覆盖 ${this._coverPct(inv.buyQueued, inv.shortSize)}%`;
    return '无库存';
  }

  _shouldAllowNewBuy() {
    if (this.config.mode === 'short') return false;
    if (this.config.mode === 'long') return true;
    const { longSize, sellQueued } = this._inventorySnapshot();
    const maxLong = this.config.gridCount * this.config.sizeBase * MAX_LONG_GRID_MULT;
    if (longSize >= maxLong) return false;
    if (longSize > 0 && sellQueued < longSize * SELL_COVERAGE_TARGET) return false;
    return true;
  }

  _shouldAllowNewSell() {
    if (this.config.mode === 'long') return false;
    if (this.config.mode === 'short') return true;
    const { shortSize, buyQueued } = this._inventorySnapshot();
    const maxShort = this.config.gridCount * this.config.sizeBase * MAX_SHORT_GRID_MULT;
    if (shortSize >= maxShort) return false;
    if (shortSize > 0 && buyQueued < shortSize * SELL_COVERAGE_TARGET) return false;
    return true;
  }

  _quoteKey(side, price, stepP) {
    return `${side}:${snapPx(price, stepP)}`;
  }

  async _dedupeLiveOrders() {
    const stepP = Number(this.config.stepPrice) || 0.01;
    const live = this._liveOpenOrders();
    const keep = new Map();
    const cancel = [];
    for (const o of live) {
      const key = this._quoteKey(o.side, o.price, stepP);
      if (!keep.has(key)) keep.set(key, o.orderId);
      else cancel.push(o.orderId);
    }
    for (const id of cancel) {
      await this.ex.cancelOrder(this.config.marketId, id).catch(() => {});
      this.active.delete(String(id));
    }
    if (cancel.length) this._alert(`🧹 撤销 ${cancel.length} 笔同价重复挂单`);
  }

  _hasLiveOrder(side, price, stepP) {
    const live = this._liveOpenOrders();
    return live.some((o) => o.side === side && Math.abs(o.price - price) <= stepP * 0.51);
  }

  async _freeMarginForSell() {
    const buys = this._liveOpenOrders()
      .filter((o) => o.side === 'buy' && !o.reduceOnly)
      .sort((a, b) => a.price - b.price);
    if (!buys.length) return false;
    const target = buys[0];
    await this.ex.cancelOrder(this.config.marketId, target.orderId).catch(() => {});
    this.active.delete(String(target.orderId));
    await new Promise((r) => setTimeout(r, 500));
    return true;
  }

  async _freeMarginForBuy() {
    const sells = this._liveOpenOrders()
      .filter((o) => o.side === 'sell' && !o.reduceOnly)
      .sort((a, b) => b.price - a.price);
    if (!sells.length) return false;
    const target = sells[0];
    await this.ex.cancelOrder(this.config.marketId, target.orderId).catch(() => {});
    this.active.delete(String(target.orderId));
    await new Promise((r) => setTimeout(r, 500));
    return true;
  }

  async _place(o) {
    if (o.side === 'buy' && !this._shouldAllowNewBuy()) return null;
    if (o.side === 'sell' && !this._shouldAllowNewSell()) return null;

    const stepP = Number(this.config.stepPrice) || 0.01;
    const price = snapPx(o.price, stepP);
    const quoteKey = this._quoteKey(o.side, price, stepP);
    if (this._placing.has(quoteKey) || this._hasLiveOrder(o.side, price, stepP)) return null;

    this._placing.add(quoteKey);
    try {
    let reduceOnly = o.reduceOnly ?? isReduceOnly(o.side, this.config.mode);
    const pos = this.ex.getPosition?.(this.config.marketId);
    const minSz = Number(this.config.stepSize) || 0.0001;
    if (this.config.mode === 'neutral' && pos && !this._seeding) {
      if (o.side === 'sell' && pos.sizeBase > 0) reduceOnly = true;
      if (o.side === 'buy' && pos.sizeBase < 0) reduceOnly = true;
    }
    let sizeBase = this.config.sizeBase;
    if (reduceOnly) {
      if (!pos || (o.side === 'sell' && !(pos.sizeBase > minSz * 0.5)) || (o.side === 'buy' && !(pos.sizeBase < -minSz * 0.5))) {
        return null;
      }
      if (o.side === 'sell') sizeBase = Math.min(sizeBase, pos.sizeBase);
      else sizeBase = Math.min(sizeBase, Math.abs(pos.sizeBase));
      if (!(sizeBase >= minSz * 0.5)) return null;
    }

    const payload = {
      marketId: this.config.marketId,
      side: o.side,
      price,
      sizeBase,
      reduceOnly,
      levelIndex: o.levelIndex,
      clientOrderId: Number(`${o.levelIndex}${o.side === 'buy' ? 0 : 1}${Date.now() % 100000}`),
    };

    const tryPlace = () => this.ex.placeLimitOrder(payload);

    let r = await tryPlace().catch(async (e) => {
      const msg = String(e.message || e);
      if (o.side === 'sell' && /margin|insufficient|1141/i.test(msg)) {
        const freed = await this._freeMarginForSell();
        if (freed) {
          return tryPlace().catch((e2) => {
            this._alert(`下单失败: ${e2.message}`);
            return null;
          });
        }
      }
      if (o.side === 'buy' && /margin|insufficient|1141/i.test(msg)) {
        const freed = await this._freeMarginForBuy();
        if (freed) {
          return tryPlace().catch((e2) => {
            this._alert(`下单失败: ${e2.message}`);
            return null;
          });
        }
      }
      this._alert(`下单失败: ${msg}`);
      return null;
    });

    if (r?.orderId) {
      this.active.set(r.orderId, { levelIndex: o.levelIndex, side: o.side, price });
      return r.orderId;
    }
    return null;
    } finally {
      this._placing.delete(quoteKey);
    }
  }

  async _rebalanceSells(price) {
    if (this.config.mode !== 'neutral') return;
    const px = Number(price ?? this.lastPrice);
    if (!(px > 0)) return;

    const stepP = Number(this.config.stepPrice) || 0.01;
    let { longSize, sellQueued } = this._inventorySnapshot();
    if (longSize <= 0) return;

    const target = longSize * SELL_COVERAGE_TARGET;
    if (sellQueued >= target - 1e-9) return;

    let need = target - sellQueued;
    const candidates = [];
    for (let i = 0; i < this.grid.levels.length; i++) {
      const lvl = snapPx(this.grid.levels[i], stepP);
      if (lvl <= px) continue;
      candidates.push({ levelIndex: i, price: lvl, side: 'sell', reduceOnly: true });
    }
    candidates.sort((a, b) => a.price - b.price);

    for (const c of candidates) {
      if (need <= 0) break;
      if (this._hasLiveOrder('sell', c.price, stepP)) continue;
      const id = await this._place(c);
      if (id) need -= this.config.sizeBase;
    }

    ({ longSize, sellQueued } = this._inventorySnapshot());
    if (longSize > 0 && sellQueued < longSize * SELL_COVERAGE_TARGET) {
      this._alert(`⚠️ 卖单覆盖 ${this._coverPct(sellQueued, longSize)}%（目标 ${SELL_COVERAGE_TARGET * 100}%），已尽力补卖；请留意保证金`);
    }
  }

  async _rebalanceBuys(price) {
    if (this.config.mode !== 'neutral') return;
    const px = Number(price ?? this.lastPrice);
    if (!(px > 0)) return;

    const stepP = Number(this.config.stepPrice) || 0.01;
    let { shortSize, buyQueued } = this._inventorySnapshot();
    if (shortSize <= 0) return;

    const target = shortSize * SELL_COVERAGE_TARGET;
    if (buyQueued >= target - 1e-9) return;

    let need = target - buyQueued;
    const candidates = [];
    for (let i = 0; i < this.grid.levels.length; i++) {
      const lvl = snapPx(this.grid.levels[i], stepP);
      if (lvl >= px) continue;
      candidates.push({ levelIndex: i, price: lvl, side: 'buy', reduceOnly: true });
    }
    candidates.sort((a, b) => b.price - a.price);

    for (const c of candidates) {
      if (need <= 0) break;
      if (this._hasLiveOrder('buy', c.price, stepP)) continue;
      const id = await this._place(c);
      if (id) need -= this.config.sizeBase;
    }

    ({ shortSize, buyQueued } = this._inventorySnapshot());
    if (shortSize > 0 && buyQueued < shortSize * SELL_COVERAGE_TARGET) {
      this._alert(`⚠️ 买单覆盖 ${this._coverPct(buyQueued, shortSize)}%（目标 ${SELL_COVERAGE_TARGET * 100}%），已尽力补买；请留意保证金`);
    }
  }

  _handleCancel(c) {
    if (!this.config || c.marketId !== this.config.marketId) return;
    this.active.delete(String(c.orderId));
  }

  _handleFill(f) {
    this._handleFillAsync(f).catch((e) => this._alert(`补单失败: ${e.message}`));
  }

  async _handleFillAsync(f) {
    if (!this.running || f.marketId !== this.config.marketId) return;
    this.active.delete(f.orderId);
    if (f.side === 'buy') this.stats.buys++; else this.stats.sells++;
    this.stats.volume = round2(this.stats.volume + f.price * f.sizeBase);
    this.fills.unshift({
      t: Date.now(), side: f.side, price: f.price, size: f.sizeBase, level: f.levelIndex,
      symbol: this.config.displayName, marketId: this.config.marketId,
    });
    if (this.fills.length > 50) this.fills.pop();

    const closing = (this.config.mode === 'short') ? f.side === 'buy' : f.side === 'sell';
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

    if (!this.outOfRange) {
      const repl = replacementFor({ side: f.side, levelIndex: f.levelIndex }, this.grid.levels, this.config.mode);
      if (repl) await this._place(repl);
      await this.rebalanceInventory(f.price);
    }
  }

  _handlePrice(p) {
    if (p.marketId !== this.config.marketId || !this.running) return;
    this.lastPrice = p.price;
    const out = p.price < this.config.lower || p.price > this.config.upper;

    if (out && !this.outOfRange) {
      this.outOfRange = true;
      this.outOfRangeSince = Date.now();
      const where = p.price < this.config.lower ? '跌破下边界' : '突破上边界';
      if (this.config.autoRecenter) {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），DGT 移框重挂（不停止）。`);
        const force = this.config.onBreakRange === 'shiftGrid';
        this.recenter(p.price, { force: force || undefined }).catch((e) => this._alert('重挂失败: ' + e.message));
      } else if (this.config.autoStopOutOfRange) {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），触发自动停止。`);
        this.stop({ closePosition: true });
      } else {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），已暂停区间外补单。`);
      }
    } else if (out && this.outOfRange && this.config.autoRecenter) {
      if (this.lastRecenterAt && Date.now() - this.lastRecenterAt >= this.config.recenterCooldownMs) {
        this.recenter(p.price).catch(() => {});
      }
    } else if (!out && this.outOfRange) {
      this.outOfRange = false;
      this.outOfRangeSince = null;
      this._alert(`价格回到区间内（${round2(p.price)}），恢复正常网格运行。`);
    }
  }

  _alert(message) {
    this.alerts.unshift({ t: Date.now(), message });
    if (this.alerts.length > 30) this.alerts.pop();
    if (this.config?.marketId) {
      this.journal?.recordAlert({
        marketId: this.config.marketId,
        symbol: this.config.displayName,
        message,
      });
    }
  }

  _liveOpenOrders() {
    if (!this.config?.marketId) return [];
    return this.ex.getOpenOrdersForMarket?.(this.config.marketId) ?? [];
  }

  getState() {
    const pos = this.running || this.config ? this.ex.getPosition?.(this.config?.marketId) : null;
    const realized = typeof this.ex.realizedPnl === 'number' ? round2(this.ex.realizedPnl) : this.stats.gridProfit;
    const live = this._liveOpenOrders();
    const liveIds = new Set(live.map((o) => o.orderId));
    for (const id of [...this.active.keys()]) {
      if (!liveIds.has(id)) this.active.delete(id);
    }
    const openByLevel = {};
    const openOrdersList = live.map((o) => {
      const levelIndex = o.levelIndex ?? this.active.get(o.orderId)?.levelIndex ?? null;
      if (levelIndex != null) openByLevel[levelIndex] = o.side;
      return {
        orderId: o.orderId,
        levelIndex,
        side: o.side,
        price: round2(o.price),
        type: o.type,
        reduceOnly: o.reduceOnly,
      };
    });
    openOrdersList.sort((a, b) => b.price - a.price);
    const inv = this._inventorySnapshot();
    const coverSide = inv.longSize > 0 ? 'sell' : inv.shortSize > 0 ? 'buy' : null;
    const coverPct = inv.longSize > 0
      ? this._coverPct(inv.sellQueued, inv.longSize)
      : inv.shortSize > 0
        ? this._coverPct(inv.buyQueued, inv.shortSize)
        : 100;
    const unrealized = pos ? round2(pos.unrealizedPnl) : 0;
    const balance = typeof this.ex.balance === 'number' ? round2(this.ex.balance) : null;
    const totalPnl = round2(realized + unrealized);
    const equity = balance != null ? round2(balance + unrealized) : null;
    const returnPct = (equity && equity > 0) ? round2((totalPnl / equity) * 100) : null;
    const displayStats = (this.journal && this.config?.marketId)
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
      openOrders: live.length,
      openOrdersList,
      openByLevel,
      inventory: {
        position: round6(inv.signed),
        longSize: round6(inv.longSize),
        shortSize: round6(inv.shortSize),
        sellQueued: round6(inv.sellQueued),
        buyQueued: round6(inv.buyQueued),
        sellCoverPct: inv.longSize > 0 ? this._coverPct(inv.sellQueued, inv.longSize) : null,
        buyCoverPct: inv.shortSize > 0 ? this._coverPct(inv.buyQueued, inv.shortSize) : null,
        coverSide,
        coverPct,
        nearestOrderPct: this.nearestOrderDistancePct(),
      },
      position: pos ? { sizeBase: round6(pos.sizeBase), entryPrice: round2(pos.entryPrice), unrealizedPnl: round2(pos.unrealizedPnl), leverage: pos.leverage ?? null } : null,
      startUnrealized: this.startUnrealized ?? 0,
      startedAt: this.startedAt ?? null,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      totalPnl,
      returnPct,
      equity,
      balance,
      volume: this.stats.volume,
      startBalance: this.startBalance != null ? round2(this.startBalance) : null,
      fills: this.fills.slice(0, 20),
      alerts: this.alerts.slice(0, 12),
    };
  }
}

function labelMode(m) { return m === 'long' ? '做多网格' : m === 'short' ? '做空网格' : '中性网格'; }
function round2(x) { return Math.round(x * 100) / 100; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function snapPx(px, step) {
  const s = Number(step) || 0.01;
  return Math.round(Math.round(px / s) * s * 100) / 100;
}
