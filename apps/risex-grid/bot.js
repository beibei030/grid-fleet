// GridBot: orchestrates an arithmetic grid on one market. Places the initial
// ladder of limit orders, and on every fill places the opposite order one rung
// away (buy->sell up, sell->buy down), capturing `spacing * size` per round.
// Out-of-range: recenter grid around price (default) instead of auto-stop.
import { buildGrid, seedOrders, replacementFor, isReduceOnly } from './grid.js';

const DETACH_RECENTER_MS = 30 * 60 * 1000;
const SEED_GRACE_MS = 45 * 60 * 1000;
const HEAL_COOLDOWN_MS = 25_000;
const INVENTORY_COVER_RATIO = 0.7;
const HEAVY_POSITION_MULT = 4;

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
    this._detachedSince = null;
    this._lastHealAt = 0;
    this._lastInventoryAt = 0;
    this._onFill = (f) => this._handleFill(f);
    this._onPrice = (p) => this._handlePrice(p);
    this._onOpenOrdersSync = (e) => this._handleOpenOrdersSync(e);
    this._onOrderCancelled = (e) => this._handleOrderCancelled(e);
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
      skipBand: cfg.skipBand != null ? Number(cfg.skipBand) : 0.10,
      stepSize: market.stepSize,
      stepPrice: market.stepPrice,
    };
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });

    const mid = (this.config.lower + this.config.upper) / 2;
    const notional = this.grid.count * sizeBase * mid;
    this.risk = {
      leverage,
      notional: round2(notional),
      requiredMargin: round2(notional / leverage),
      perRungProfit: round2(this.grid.spacing * sizeBase),
      spacingPct: round2((this.grid.spacing / mid) * 100),
    };

    if (process.env.RISE_SKIP_LEVERAGE !== '1' && typeof this.ex.ensureLeverage === 'function') {
      await this.ex.ensureLeverage(market.marketId, leverage).catch((e) => {
        this._alert(`⚠️ 链上杠杆未设为 ${leverage}x：${e.message}。请在 rise.trade 该市场手动改为 ${leverage}x，否则持仓可能仍显示 20x。`);
      });
    } else if (process.env.RISE_SKIP_LEVERAGE !== '1') {
      const ok = await this.ex.setLeverage(market.marketId, leverage);
      if (ok === false) {
        this._alert(`⚠️ 链上杠杆未设为 ${leverage}x，请在 rise.trade 手动调整。`);
      }
    }
    this.lastPrice = await this.ex.getPrice(market.marketId);
    this.outOfRange = this.lastPrice < this.config.lower || this.lastPrice > this.config.upper;
    this.outOfRangeSince = this.outOfRange ? Date.now() : null;
    this.stoppedAt = null;

    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    this.ex.on('openOrdersSync', this._onOpenOrdersSync);
    this.ex.on('orderCancelled', this._onOrderCancelled);
    if (typeof this.ex.start === 'function') this.ex.start();
    let cached = this.ex.getCachedOpenOrders?.(market.marketId) || [];
    if (typeof this.ex.fetchAllOpenOrders === 'function') {
      const all = await this.ex.fetchAllOpenOrders().catch(() => []);
      const fromFetch = (all || []).filter((o) => Number(o.marketId) === market.marketId);
      if (fromFetch.length > cached.length) cached = fromFetch;
    }
    const minKeep = Math.max(6, Math.floor(this.grid.count * 0.4));
    if (cached.length >= minKeep) {
      this._adoptExistingOrders(cached);
      const missing = this._missingSeeds(cached, { force: true });
      for (const s of missing.slice(0, 2)) {
        await this._place(s);
        await this._chainGap();
      }
      this._alert(`承接链上 ${cached.length} 单，跳过 cancelAll，缺口 ${missing.length} 格待续补。`);
    } else {
      await this.ex.cancelAll(market.marketId).catch(() => {});
      await this._seedAround(this.lastPrice);
    }
    await this._ensureInventorySells();
    await this._ensureInventoryBuys();

    if (this.startBalance == null && typeof this.ex.balance === 'number') this.startBalance = this.ex.balance;
    const pos0 = this.ex.getPosition?.(market.marketId);
    this.startUnrealized = pos0 ? round2(pos0.unrealizedPnl) : 0;
    this.startedAt = Date.now();
    this.running = true;
    this._alert(`已启动 ${this.config.displayName} ${labelMode(this.config.mode)}，${this.grid.count} 格，间距 ${this.grid.spacing}（${this.risk.spacingPct}%），杠杆 ${leverage}x，区间 ${this.config.lower}~${this.config.upper}，挂出 ${this.active.size} 单。`);
    return this.getState();
  }

  isSeeding() {
    return !!this._seeding;
  }

  _inSeedGrace() {
    return !!(this.startedAt && Date.now() - this.startedAt < SEED_GRACE_MS);
  }

  _adoptExistingOrders(cached) {
    for (const o of cached) {
      if (!(o.price > 0) || !o.orderId) continue;
      const idx = matchLevelIndex(this, o.price);
      if (idx == null) continue;
      this.active.set(String(o.orderId), {
        levelIndex: idx,
        side: o.side,
        price: this.grid.levels[idx],
        reduceOnly: !!(o.reduceOnly ?? isReduceOnly(o.side, this.config.mode)),
      });
    }
  }

  async _chainGap() {
    const gap = (this.ex.orderGapMs ?? 11000) - (Date.now() - (this.ex._lastChainAt ?? 0));
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
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
        await this._place(s);
        await this._chainGap();
      }
    } finally {
      this._seeding = false;
    }
  }

  /** 初始铺单未完成时逐格补挂（遵守链上限速，最多约 8 分钟） */
  async completeInitialSeed({ timeoutMs = 180000 } = {}) {
    if (!this.running || !this.config) return { ok: false, openOrders: 0 };
    const target = Math.max(8, (this.config.gridCount ?? 22) - 4);
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;
    while (Date.now() < deadline) {
      const cached = this.ex.getCachedOpenOrders?.(this.config.marketId) || [];
      const missing = this._missingSeeds(cached);
      if (cached.length >= target || missing.length === 0) {
        return { ok: true, openOrders: cached.length, target };
      }
      if (cached.length === lastCount && missing.length) {
        await this._healMissingRungs(cached).catch(() => {});
      } else if (missing.length) {
        await this._place(missing[0]);
        await this._chainGap();
      }
      lastCount = cached.length;
      await new Promise((r) => setTimeout(r, 4000));
    }
    const cached = this.ex.getCachedOpenOrders?.(this.config.marketId) || [];
    return { ok: cached.length >= target * 0.6, openOrders: cached.length, target };
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
      this.config.lower = lower;
      this.config.upper = upper;
      this.grid = buildGrid({ lower, upper, gridCount: this.config.gridCount });

      const mid = (lower + upper) / 2;
      this.risk = {
        ...this.risk,
        perRungProfit: round2(this.grid.spacing * this.config.sizeBase),
        spacingPct: round2((this.grid.spacing / mid) * 100),
      };

      this.lastPrice = px;
      this.outOfRange = false;
      this.outOfRangeSince = null;
      this.lastRecenterAt = now;
      await this._seedAround(px);
      await this._ensureInventorySells();
      await this._ensureInventoryBuys();
      this._detachedSince = null;
      this._alert(`↻ 已以 ${round2(px)} 为中心重挂网格（±${(half * 100).toFixed(1)}%），${this.config.lower}~${this.config.upper}，${this.active.size} 单。`);
      return true;
    } finally {
      this._recentering = false;
    }
  }

  async stop({ closePosition = false } = {}) {
    if (!this.running) return this.getState();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    this.ex.off('openOrdersSync', this._onOpenOrdersSync);
    this.ex.off('orderCancelled', this._onOrderCancelled);
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

  async _place(o) {
    let reduceOnly = o.reduceOnly ?? isReduceOnly(o.side, this.config.mode);
    let sizeBase = Number(o.sizeBase) > 0 ? Number(o.sizeBase) : this.config.sizeBase;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (this.config.mode === 'neutral' && pos && !this._seeding) {
      if (o.side === 'sell' && pos.sizeBase > 0) reduceOnly = true;
      if (o.side === 'buy' && pos.sizeBase < 0) reduceOnly = true;
    }
    if (reduceOnly && pos) {
      if (o.side === 'sell') {
        if (!(pos.sizeBase > 0)) return null;
        sizeBase = Math.min(sizeBase, pos.sizeBase);
      } else if (o.side === 'buy') {
        if (!(pos.sizeBase < 0)) return null;
        sizeBase = Math.min(sizeBase, Math.abs(pos.sizeBase));
      }
    } else if (reduceOnly) {
      return null;
    }
    const minSz = Number(this.config.stepSize) || 0.0001;
    if (!(sizeBase >= minSz * 0.5)) return null;

    const clientOrderId = Number(`${o.levelIndex}${o.side === 'buy' ? 0 : 1}${Date.now() % 100000}`);
    const r = await this.ex.placeLimitOrder({
      marketId: this.config.marketId, side: o.side, price: o.price,
      sizeBase, reduceOnly,
      levelIndex: o.levelIndex, clientOrderId,
    }).catch((e) => {
      const msg = e?.message || '';
      if (/insufficient cross margin|insufficient margin/i.test(msg) && o.side === 'sell') {
        this._trimBuysForMargin().catch(() => {});
      }
      this._alert('下单失败: ' + msg);
      return null;
    });
    if (r?.orderId) {
      this.active.set(r.orderId, {
        levelIndex: o.levelIndex,
        side: o.side,
        price: o.price,
        reduceOnly: !!(o.reduceOnly ?? isReduceOnly(o.side, this.config.mode)),
      });
      return r.orderId;
    }
    return null;
  }

  _positionFlags(pos) {
    const sz = this.config?.sizeBase ?? 0;
    const heavyLong = !!(pos && pos.sizeBase > sz * HEAVY_POSITION_MULT);
    const heavyShort = !!(pos && pos.sizeBase < -sz * HEAVY_POSITION_MULT);
    return { heavyLong, heavyShort };
  }

  /** 挂单是否 bracket 现价（检测脱节） */
  _bracketState(officialList, px) {
    const priced = (officialList || []).filter((o) => o.price > 0);
    const spacing = this.grid?.spacing ?? 0;
    const band = spacing * (this.config?.skipBand ?? 0.1);
    const buys = priced.filter((o) => o.side === 'buy');
    const sells = priced.filter((o) => o.side === 'sell');
    const maxBuy = buys.length ? Math.max(...buys.map((o) => o.price)) : null;
    const minSell = sells.length ? Math.min(...sells.map((o) => o.price)) : null;
    const buysBelow = buys.some((o) => o.price < px - band * 0.5);
    const sellsAbove = sells.some((o) => o.price > px + band * 0.5);
    const detachedUp = priced.length > 0 && maxBuy != null && maxBuy < px - spacing;
    const detachedDown = priced.length > 0 && minSell != null && minSell > px + spacing;
    const detached = detachedUp || detachedDown
      || (priced.length > 0 && !buysBelow && !sellsAbove);
    return {
      buysBelow, sellsAbove, maxBuy, minSell, detached, detachedUp, detachedDown, spacing,
    };
  }

  checkGridHealth() {
    if (!this.running || !this.config) return null;
    const px = this.lastPrice;
    if (!(px > 0)) return null;
    const cached = this.ex.getCachedOpenOrders?.(this.config.marketId) || [];
    const br = this._bracketState(cached, px);
    return {
      ...br,
      orderCount: cached.length,
      underFilled: cached.length < (this.config.gridCount - 2),
      detachedMs: this._detachedSince ? Date.now() - this._detachedSince : 0,
    };
  }

  _orderKey(side, price, stepP) {
    return `${side}:${snapPx(price, stepP)}`;
  }

  /** 多头过重且保证金不足时，撤最远离现价的一档买单以腾挪卖单保证金 */
  async _trimBuysForMargin() {
    const cached = this.ex.getCachedOpenOrders?.(this.config.marketId) || [];
    const px = this.lastPrice ?? 0;
    const buys = cached
      .filter((o) => o.side === 'buy')
      .sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px));
    const victim = buys[buys.length - 1];
    if (!victim?.orderId || typeof this.ex.cancelOrder !== 'function') return;
    await this.ex.cancelOrder(this.config.marketId, victim.orderId, victim.restingOrderId).catch(() => {});
    this.active.delete(String(victim.orderId));
    this._alert(`⚠️ 保证金不足，已撤销最远买单 @ ${round2(victim.price)} 以便挂卖单兑现浮盈。`);
    await this._ensureInventorySells().catch(() => {});
  }

  _handleFill(f) {
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

    const repl = replacementFor({ side: f.side, levelIndex: f.levelIndex }, this.grid.levels, this.config.mode);
    const pos = this.ex.getPosition?.(this.config.marketId);
    const { heavyLong, heavyShort } = this._positionFlags(pos);
    if (repl && !this.outOfRange) {
      if (heavyLong && repl.side === 'buy' && !repl.reduceOnly) { /* skip add-long */ }
      else if (heavyShort && repl.side === 'sell' && !repl.reduceOnly) { /* skip add-short */ }
      else this._place(repl);
    } else if (f.side === 'buy' && !this.outOfRange) {
      this._ensureInventorySells().catch(() => {});
    } else if (f.side === 'sell' && !this.outOfRange) {
      this._ensureInventoryBuys().catch(() => {});
    }
  }

  _handleOrderCancelled({ marketId, orderId }) {
    if (!this.running || marketId !== this.config.marketId) return;
    this.active.delete(String(orderId));
  }

  _handleOpenOrdersSync({ marketId, liveIds, officialList }) {
    if (!this.running || marketId !== this.config.marketId) return;
    const before = this.active.size;
    this._reconcileActive(liveIds);
    this._onSyncCleanup(officialList || [], before).catch(() => {});
  }

  async _onSyncCleanup(officialList, activeBefore) {
    // RISEx has an address-level order quota. In normal operation, never
    // spend maintenance cycles tearing down resting orders unless explicitly
    // enabled; parsed price=0 rows are often API decode gaps, not bad orders.
    const allowAutoCancel = process.env.RISE_ALLOW_AUTO_CANCEL === '1';
    const { cancelled, list } = allowAutoCancel
      ? await this._dedupeOrders(officialList)
      : { cancelled: 0, list: officialList };
    if (!this._seeding && !this._inSeedGrace()) {
      await this._checkDetachedAndRecenter(list);
    }
    if (allowAutoCancel) await this._cancelRiskAdds(list);
    const overGrid = list.length > this.grid.count + 4;
    const missing = this._missingSeeds(list).length;
    const healDue = Date.now() - (this._lastHealAt || 0) >= HEAL_COOLDOWN_MS;
    if (healDue && (activeBefore > this.active.size || cancelled > 0 || overGrid || missing > 0)) {
      this._lastHealAt = Date.now();
      await this._healMissingRungs(list).catch(() => {});
    }
    await this._ensureInventorySells().catch(() => {});
    await this._ensureInventoryBuys().catch(() => {});
  }

  async _checkDetachedAndRecenter(officialList) {
    if (!this.running || this.outOfRange || this._recentering || !this.config.autoRecenter) return;
    if (this._seeding || this._inSeedGrace()) return;
    const h = this.checkGridHealth?.();
    if (h?.underFilled) return;
    const px = this.lastPrice ?? await this.ex.getPrice(this.config.marketId);
    if (!(px > 0)) return;
    const br = this._bracketState(officialList, px);
    if (!br.detached) {
      this._detachedSince = null;
      return;
    }
    if (!this._detachedSince) {
      this._detachedSince = Date.now();
      this._alert(`⚠️ 挂单与现价脱节（买最高 ${br.maxBuy != null ? round2(br.maxBuy) : '—'} / 卖最低 ${br.minSell != null ? round2(br.minSell) : '—'}，现价 ${round2(px)}），将补挂或重挂。`);
      return;
    }
    const gapUp = br.detachedUp && br.maxBuy != null ? px - br.maxBuy : 0;
    const severe = gapUp > br.spacing * 8;
    const waited = Date.now() - this._detachedSince;
    if (severe || waited >= DETACH_RECENTER_MS) {
      const ok = await this.recenter(px, { force: severe });
      if (ok) this._detachedSince = null;
    }
  }

  async _cancelRiskAdds(officialList) {
    const pos = this.ex.getPosition?.(this.config.marketId);
    const { heavyLong, heavyShort } = this._positionFlags(pos);
    if (!heavyLong && !heavyShort) return;
    let victim = null;
    if (heavyShort) {
      for (const o of [...officialList].filter((x) => x.side === 'sell' && x.price > 0).sort((a, b) => b.price - a.price)) {
        if (o.reduceOnly || this.active.get(String(o.orderId))?.reduceOnly) continue;
        victim = o;
        break;
      }
    } else {
      for (const o of [...officialList].filter((x) => x.side === 'buy' && x.price > 0).sort((a, b) => a.price - b.price)) {
        if (o.reduceOnly || this.active.get(String(o.orderId))?.reduceOnly) continue;
        victim = o;
        break;
      }
    }
    if (!victim?.orderId || typeof this.ex.cancelOrder !== 'function') return;
    await this.ex.cancelOrder(this.config.marketId, victim.orderId, victim.restingOrderId).catch(() => {});
    this.active.delete(String(victim.orderId));
    const side = heavyShort ? '加空卖单' : '加多买单';
    this._alert(`🧹 持仓过重，已撤 ${side} @ ${round2(victim.price)}`);
    const gap = (this.ex.orderGapMs ?? 11000) - (Date.now() - (this.ex._lastChainAt ?? 0));
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  }

  /** 当前价下应有但链上/本地均未覆盖的网格档位 */
  _missingSeeds(officialList = [], { force = false } = {}) {
    if (!force && (!this.running || this.outOfRange || this._recentering)) return [];
    const px = this.lastPrice ?? this.ex._prices?.get?.(this.config.marketId);
    if (!(px > 0)) return [];
    const stepP = Number(this.config.stepPrice) || 0.01;
    const officialKeys = new Set(
      officialList.filter((o) => o.price > 0).map((o) => this._orderKey(o.side, o.price, stepP)),
    );
    const occupiedLevels = new Set([...this.active.values()].map((o) => o.levelIndex));
    const pos = this.ex.getPosition?.(this.config.marketId);
    const { heavyLong, heavyShort } = this._positionFlags(pos);
    const br = this._bracketState(officialList, px);
    const seeds = seedOrders({
      levels: this.grid.levels,
      price: px,
      mode: this.config.mode,
      spacing: this.grid.spacing,
      skipBand: this.config.skipBand,
    });
    return seeds.filter((s) => {
      if (heavyLong && s.side === 'buy' && !s.reduceOnly && br.buysBelow) return false;
      if (heavyShort && s.side === 'sell' && !s.reduceOnly && br.sellsAbove) return false;
      if (occupiedLevels.has(s.levelIndex)) return false;
      if (officialKeys.has(this._orderKey(s.side, s.price, stepP))) return false;
      return true;
    });
  }

  _sortMissingForHeal(missing, officialList, px) {
    const br = this._bracketState(officialList, px);
    const rank = (s) => {
      if (br.detachedUp && s.side === 'sell' && s.price > px) return 0;
      if (br.detachedDown && s.side === 'buy' && s.price < px) return 0;
      if (!br.sellsAbove && s.side === 'sell' && s.price > px) return 1;
      if (!br.buysBelow && s.side === 'buy' && s.price < px) return 1;
      return 2;
    };
    return [...missing].sort((a, b) => rank(a) - rank(b) || Math.abs(a.price - px) - Math.abs(b.price - px));
  }

  /** 撤销不在当前网格档位上的遗留挂单（旧区间 recenter 残留） */
  async _trimOffGridOrders(officialList = []) {
    if (!this.running || this._recentering) return { cancelled: 0, list: officialList };
    const stepP = Number(this.config.stepPrice) || 0.01;
    const tol = stepP * 0.51;
    const onGrid = (px) => this.grid.levels.some((l) => Math.abs(l - px) <= tol);
    let cancelled = 0;
    const keep = [];
    for (const o of officialList) {
      if (o.price > 0 && onGrid(o.price)) {
        keep.push(o);
        continue;
      }
      if (typeof this.ex.cancelOrder !== 'function') continue;
      await this.ex.cancelOrder(this.config.marketId, o.orderId, o.restingOrderId).catch(() => {});
      this.active.delete(String(o.orderId));
      cancelled++;
      const gap = (this.ex.orderGapMs ?? 900) - (Date.now() - (this.ex._lastChainAt ?? 0));
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    if (cancelled > 0) {
      this._alert(`🧹 已撤销 ${cancelled} 个偏离当前网格的旧单`);
    }
    return { cancelled, list: keep };
  }

  /** 撤销同价同向重复挂单，只保留 1 单 */
  async _dedupeOrders(officialList = []) {
    const stepP = Number(this.config.stepPrice) || 0.01;
    const byKey = new Map();
    const keepIds = new Set();
    let cancelled = 0;
    for (const o of officialList) {
      if (!(o.price > 0)) {
        // Do not cancel ambiguous price=0 rows. RISEx sometimes omits enough
        // fields for local price reconstruction; canceling here creates holes.
        keepIds.add(String(o.orderId));
        continue;
      }
      const key = this._orderKey(o.side, o.price, stepP);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(o);
    }
    for (const orders of byKey.values()) {
      const keep = orders.find((o) => this.active.has(String(o.orderId))) || orders[0];
      keepIds.add(String(keep.orderId));
      for (const o of orders) {
        if (String(o.orderId) === String(keep.orderId)) continue;
        if (typeof this.ex.cancelOrder !== 'function') continue;
        await this.ex.cancelOrder(this.config.marketId, o.orderId, o.restingOrderId).catch(() => {});
        this.active.delete(String(o.orderId));
        cancelled++;
        const gap = (this.ex.orderGapMs ?? 900) - (Date.now() - (this.ex._lastChainAt ?? 0));
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      }
    }
    if (cancelled > 0) {
      this._alert(`🧹 已撤销 ${cancelled} 个重复挂单（同价同向）`);
    }
    const list = officialList.filter((o) => keepIds.has(String(o.orderId)));
    return { cancelled, list };
  }

  _reconcileActive(liveIds) {
    for (const id of [...this.active.keys()]) {
      if (!liveIds.has(String(id))) this.active.delete(id);
    }
  }

  /**
   * 中性网格上涨后常见：净多头 + 现价贴近区间上沿，上方无卖单 → 浮盈无法兑现。
   * 在仍有持仓且现价以上无卖单时，于上方网格档位挂 reduce-only 卖单。
   */
  async _ensureInventorySells() {
    if (!this.running || this.outOfRange || this._recentering) return;
    if (Date.now() - (this._lastInventoryAt || 0) < 30_000) return;
    if (this.config.mode !== 'neutral') return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !(pos.sizeBase > 0)) return;

    const px = this.lastPrice ?? await this.ex.getPrice(this.config.marketId);
    if (!(px > 0)) return;

    const stepP = Number(this.config.stepPrice) || 0.01;
    const band = this.grid.spacing * (this.config.skipBand ?? 0.1);
    const minSz = Number(this.config.stepSize) || 0.0001;
    const cached = this.ex.getCachedOpenOrders?.(this.config.marketId) || [];
    const allSells = cached.filter((o) => o.side === 'sell');
    const sellQueued = allSells.reduce((a, o) => a + (o.sizeBase > 0 ? o.sizeBase : this.config.sizeBase), 0);
    if (sellQueued >= pos.sizeBase * 0.95) return;
    let remaining = Math.max(0, pos.sizeBase - sellQueued);
    const needCover = pos.sizeBase * INVENTORY_COVER_RATIO - sellQueued;
    if (needCover <= minSz * 0.5 || remaining <= minSz * 0.5) return;

    const officialKeys = new Set(cached.map((o) => this._orderKey(o.side, o.price, stepP)));
    const occupiedLevels = new Set([...this.active.values()].map((o) => o.levelIndex));
    const maxSells = Math.max(1, Math.min(8, Math.ceil(needCover / this.config.sizeBase)));

    let placed = 0;
    let placedSize = 0;
    for (let i = 0; i < this.grid.levels.length && placed < maxSells && remaining > minSz * 0.5; i++) {
      const lvl = this.grid.levels[i];
      if (lvl <= px + band) continue;
      if (occupiedLevels.has(i)) continue;
      if (officialKeys.has(this._orderKey('sell', lvl, stepP))) continue;
      const clipSz = Math.min(this.config.sizeBase, remaining);
      if (!(clipSz >= minSz * 0.5)) break;
      const id = await this._place({ levelIndex: i, price: lvl, side: 'sell', reduceOnly: true, sizeBase: clipSz });
      if (!id) {
        this._lastInventoryAt = Date.now() + 45_000;
        break;
      }
      placed++;
      placedSize += clipSz;
      remaining = Math.max(0, remaining - clipSz);
      const gap = (this.ex.orderGapMs ?? 900) - (Date.now() - (this.ex._lastChainAt ?? 0));
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    if (placed > 0) {
      this._lastInventoryAt = Date.now();
      this._alert(`📤 持仓 ${round6(pos.sizeBase)}，已补挂 ${placed} 个止盈卖单（reduce-only，覆盖 ~${round6(placedSize)}）。`);
    }
  }

  /**
   * 中性网格净空头：现价下方挂 reduce-only 买单平空（目标覆盖 ≥70% 空仓）。
   */
  async _ensureInventoryBuys() {
    if (!this.running || this.outOfRange || this._recentering) return;
    if (Date.now() - (this._lastInventoryAt || 0) < 30_000) return;
    if (this.config.mode !== 'neutral') return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !(pos.sizeBase < 0)) return;

    const px = this.lastPrice ?? await this.ex.getPrice(this.config.marketId);
    if (!(px > 0)) return;

    const posAbs = Math.abs(pos.sizeBase);
    const stepP = Number(this.config.stepPrice) || 0.01;
    const band = this.grid.spacing * (this.config.skipBand ?? 0.1);
    const minSz = Number(this.config.stepSize) || 0.0001;
    const cached = this.ex.getCachedOpenOrders?.(this.config.marketId) || [];
    const allBuys = cached.filter((o) => o.side === 'buy');
    const buyQueued = allBuys.reduce((a, o) => a + (o.sizeBase > 0 ? o.sizeBase : this.config.sizeBase), 0);
    if (buyQueued >= posAbs * 0.95) return;
    let remaining = Math.max(0, posAbs - buyQueued);
    const needCover = posAbs * INVENTORY_COVER_RATIO - buyQueued;
    if (needCover <= minSz * 0.5 || remaining <= minSz * 0.5) return;

    const officialKeys = new Set(cached.map((o) => this._orderKey(o.side, o.price, stepP)));
    const occupiedLevels = new Set([...this.active.values()].map((o) => o.levelIndex));
    const maxBuys = Math.max(1, Math.min(8, Math.ceil(needCover / this.config.sizeBase)));

    let placed = 0;
    let placedSize = 0;
    for (let i = this.grid.levels.length - 1; i >= 0 && placed < maxBuys && remaining > minSz * 0.5; i--) {
      const lvl = this.grid.levels[i];
      if (lvl >= px - band) continue;
      if (occupiedLevels.has(i)) continue;
      if (officialKeys.has(this._orderKey('buy', lvl, stepP))) continue;
      const clipSz = Math.min(this.config.sizeBase, remaining);
      if (!(clipSz >= minSz * 0.5)) break;
      const id = await this._place({ levelIndex: i, price: lvl, side: 'buy', reduceOnly: true, sizeBase: clipSz });
      if (!id) {
        this._lastInventoryAt = Date.now() + 45_000;
        break;
      }
      placed++;
      placedSize += clipSz;
      remaining = Math.max(0, remaining - clipSz);
      const gap = (this.ex.orderGapMs ?? 900) - (Date.now() - (this.ex._lastChainAt ?? 0));
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    if (placed > 0) {
      this._lastInventoryAt = Date.now();
      this._alert(`📥 空仓 ${round6(posAbs)}，已补挂 ${placed} 个平空买单（reduce-only，~${round6(placedSize)}）。`);
    }
  }

  /** 补回应有但缺失的网格档位（每轮 sync 最多 1 单，遵守链上限速） */
  async _healMissingRungs(officialList = []) {
    if (this._seeding) return;
    if (Date.now() - (this._lastHealAt || 0) < HEAL_COOLDOWN_MS) return;
    this._lastHealAt = Date.now();
    const px = this.lastPrice ?? this.ex._prices?.get?.(this.config.marketId);
    let missing = this._missingSeeds(officialList);
    if (!missing.length || !(px > 0)) return;
    missing = this._sortMissingForHeal(missing, officialList, px);
    await this._place(missing[0]);
    const gap = (this.ex.orderGapMs ?? 11000) - (Date.now() - (this.ex._lastChainAt ?? 0));
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    await this._ensureInventorySells().catch(() => {});
    await this._ensureInventoryBuys().catch(() => {});
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
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），将自动以现价重挂网格（不停止）。`);
        this.recenter(p.price, { force: true }).catch((e) => this._alert('重挂失败: ' + e.message));
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

  getState() {
    const pos = this.running || this.config ? this.ex.getPosition?.(this.config?.marketId) : null;
    const realized = typeof this.ex.realizedPnl === 'number' ? round2(this.ex.realizedPnl) : this.stats.gridProfit;
    const openByLevel = {};
    const botOpenOrdersList = [];
    for (const [orderId, o] of this.active.entries()) {
      openByLevel[o.levelIndex] = o.side;
      botOpenOrdersList.push({ orderId: String(orderId), levelIndex: o.levelIndex, side: o.side, price: round2(o.price) });
    }
    botOpenOrdersList.sort((a, b) => b.price - a.price);

    const cached = this.running && this.config?.marketId != null
      ? (this.ex.getCachedOpenOrders?.(this.config.marketId) || [])
      : [];
    const useExchange = cached.length > 0 || (this.ex.getOfficialOpenOrdersUpdatedAt?.() > 0);
    const openOrdersList = useExchange
      ? cached.map((o) => {
          const local = this.active.get(o.orderId);
          return {
            ...o,
            levelIndex: local?.levelIndex ?? matchLevelIndex(this, o.price),
            source: 'exchange',
          };
        })
      : botOpenOrdersList;
    openOrdersList.sort((a, b) => b.price - a.price);
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
      openOrders: useExchange ? cached.length : this.active.size,
      botOpenOrders: this.active.size,
      openOrdersList,
      openOrdersSource: useExchange ? 'exchange' : 'bot',
      openByLevel,
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
function round2(x) { return Math.round(x * 100) / 100; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function priceDecimals(step) {
  const s = Number(step) || 0.01;
  if (s >= 1) return 0;
  if (s >= 0.1) return 1;
  if (s >= 0.01) return 2;
  if (s >= 0.001) return 3;
  if (s >= 0.0001) return 4;
  return 6;
}
function snapPx(px, step) {
  const s = Number(step) || 0.01;
  const mult = 10 ** priceDecimals(s);
  return Math.round(Math.round(Number(px) / s) * s * mult) / mult;
}
