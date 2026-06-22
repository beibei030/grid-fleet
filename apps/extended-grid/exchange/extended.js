// ExtendedExchange: LIVE adapter for Extended (https://extended.exchange),
// a perpetuals DEX on Starknet. Zero external dependencies:
//   - REST via built-in fetch (X-Api-Key header for reads)
//   - order signing via ./starkcrypto.js (SNIP-12 + Stark ECDSA, verified
//     against the official python SDK test vectors; selfTest() runs on init)
//
// Markets on Extended are addressed by NAME ("BTC-USD"). The bot uses numeric
// marketIds, so this adapter assigns stable per-process ids (sorted by daily
// volume) and keeps the name in `market.name`.
//
// Fills are detected by polling open orders: an order we placed that is no
// longer resting is checked via GET /user/orders/{id}; if it has filledQty it
// is reported as a fill, otherwise it was cancelled externally.
import { EventEmitter } from 'node:events';
import {
  selfTest, orderMsgHash, starkSign, settlementAmounts, alignToStep, parseDec, toHex,
  publicKeyFromPrivate,
} from './starkcrypto.js';

const DOMAINS = {
  mainnet: { name: 'Perpetuals', version: 'v0', chainId: 'SN_MAIN', revision: 1 },
};
const INTERVALS = { 60: 'PT1M', 300: 'PT5M', 900: 'PT15M', 1800: 'PT30M', 3600: 'PT1H', 7200: 'PT2H', 14400: 'PT4H', 86400: 'P1D' };
const ORDER_EXPIRY_DAYS = 28;          // resting grid orders live this long
const SETTLEMENT_BUFFER_DAYS = 14;     // same buffer as the official SDK
const USER_AGENT = 'ExtendedGridBot/1.0';

export class ExtendedExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.apiKey = opts.apiKey;
    this.vault = Number(opts.vault);
    this.privateKey = BigInt(opts.privateKey);
    this.publicKey = opts.publicKey ? BigInt(opts.publicKey) : null;
    this.apiUrl = (opts.apiUrl || '').replace(/\/$/, '');
    this.network = 'mainnet';
    this.feeRate = opts.feeRate || '0.0005'; // max fee signed into orders (taker is 0.00025)
    this.pollMs = opts.pollMs ?? 2500;
    this.domain = DOMAINS.mainnet;
    this.markets = new Map();   // marketId -> market
    this.balance = null;
    this.equity = null;
    this.unrealisedPnl = null;
    this.availableForTrade = null;
    this._statsCache = null; // official stats cache
    this.pnlSinceDate = null; // YYYY-MM-DD，官网盈亏只汇总该日及以后（与本轮基准对齐）
    this.statsMarketNames = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
    this._tracked = new Map();  // orderId(str) -> {marketId, levelIndex, side, price, sizeBase, seen}
    this._watch = new Set();    // marketIds to poll
    this._pos = new Map();      // marketId -> position
    this._allPositions = [];    // 全账户持仓（与官网 positions 同步）
    this._allOpenOrders = [];     // 全账户挂单（与官网 orders 同步）
    this._accountId = null;
    this._prices = new Map();
    this._timer = null;
    this._busy = false;
  }

  async init() {
    if (!this.apiKey || !this.vault || !this.privateKey) {
      throw new Error('LIVE 模式需要 EXTENDED_API_KEY / EXTENDED_VAULT / EXTENDED_STARK_PRIVATE_KEY（在 app.extended.exchange 的 API Management 页面获取）。');
    }
    // Refuse to trade if the signing implementation doesn't reproduce the
    // official SDK test vector (protects against env/runtime quirks).
    selfTest();
    if (this.publicKey == null) this.publicKey = publicKeyFromPrivate(this.privateKey);

    const data = await this._get('/api/v1/info/markets');
    const list = (data || [])
      .filter((m) => m.active && (m.type ?? 'PERPETUAL') === 'PERPETUAL' && m.l2Config)
      .sort((a, b) => Number(b.marketStats?.dailyVolume || 0) - Number(a.marketStats?.dailyVolume || 0));
    let id = 1;
    for (const m of list) {
      const t = m.tradingConfig || {};
      const px = Number(m.marketStats?.lastPrice || m.marketStats?.markPrice || 0);
      this.markets.set(id, {
        marketId: id, name: m.name, displayName: m.name, symbol: m.assetName,
        lastPrice: px,
        stepSize: Number(t.minOrderSizeChange || t.minOrderSize), stepPrice: Number(t.minPriceChange),
        maxLeverage: Number(t.maxLeverage || 50), minOrderSize: Number(t.minOrderSize),
        qtyStep: String(t.minOrderSizeChange || t.minOrderSize), priceStep: String(t.minPriceChange),
        l2: { // keep as strings: market objects are JSON-serialized for the dashboard
          syntheticId: String(m.l2Config.syntheticId), collateralId: String(m.l2Config.collateralId),
          synRes: Number(m.l2Config.syntheticResolution), colRes: Number(m.l2Config.collateralResolution),
        },
      });
      this._prices.set(id, px);
      id++;
    }
    if (!this.markets.size) throw new Error('Extended 未返回可交易市场。');
    this.dataSource = 'real';
    await this._refreshAccount(); // also validates the API key
    await this._refreshAllPositions().catch(() => {});
    await this._refreshAllOpenOrders().catch(() => {});
    this.start();
    return true;
  }

  // ---------- HTTP ----------
  _headers() {
    return { 'X-Api-Key': this.apiKey, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async _req(method, path, body, { full = false } = {}) {
    const res = await fetch(this.apiUrl + path, {
      method, headers: this._headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    let j = null;
    try { j = await res.json(); } catch { /* some endpoints return empty bodies */ }
    if (res.status === 401) throw new Error('API key 无效或已过期 (401)。');
    if (res.status === 429) throw new Error('触发限流 (429)，请稍后重试。');
    if (j && j.status === 'ERROR') {
      const e = j.error || {};
      throw new Error(`Extended 接口错误 ${e.code || res.status}: ${e.message || JSON.stringify(j)}`);
    }
    if (!res.ok) throw new Error(`Extended 接口错误 HTTP ${res.status}: ${path}`);
    if (full) return j;
    return j ? j.data : null;
  }

  _get(path) { return this._req('GET', path); }

  /** 分页拉取账户成交（单市场，避免多 market 一次请求 403） */
  async getTradesPage(marketName, { cursor, limit = 500 } = {}) {
    const qs = new URLSearchParams();
    qs.append('market', marketName);
    if (cursor != null) qs.set('cursor', String(cursor));
    if (limit) qs.set('limit', String(limit));
    const j = await this._req('GET', `/api/v1/user/trades?${qs}`, undefined, { full: true });
    return { data: j?.data || [], pagination: j?.pagination || null };
  }

  /** 按市场名分页拉取全部历史成交 */
  async fetchAllTrades(marketNames) {
    const out = [];
    for (const name of marketNames) {
      let cursor;
      for (let page = 0; page < 50; page++) {
        const { data, pagination } = await this.getTradesPage(name, { cursor, limit: 500 });
        if (data?.length) out.push(...data);
        const next = pagination?.cursor;
        if (!data?.length || next == null || String(next) === String(cursor)) break;
        cursor = next;
      }
    }
    return out;
  }

  marketIdForName(name) {
    for (const [id, m] of this.markets) {
      if (m.name === name) return id;
    }
    return null;
  }

  /** 分页拉取已平仓位（Extended 官网同源） */
  async getPositionsHistoryPage(marketName, { cursor, limit = 50 } = {}) {
    const qs = new URLSearchParams();
    if (marketName) qs.append('market', marketName);
    if (cursor != null) qs.set('cursor', String(cursor));
    if (limit) qs.set('limit', String(limit));
    const j = await this._req('GET', `/api/v1/user/positions/history?${qs}`, undefined, { full: true });
    return { data: j?.data || [], pagination: j?.pagination || null };
  }

  /** 全账户已平仓位（不传 market，与官网 positions/history 一致） */
  async fetchAllClosedPositions() {
    const out = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const { data, pagination } = await this.getPositionsHistoryPage(null, { cursor, limit: 100 });
      for (const p of data || []) {
        if (!Number(p.closedTime || 0)) continue;
        out.push(this._mapClosedPosition(p, p.market));
      }
      const next = pagination?.cursor;
      if (!data?.length || next == null || String(next) === String(cursor)) break;
      cursor = next;
    }
    out.sort((a, b) => b.closedTime - a.closedTime);
    return out;
  }

  _mapClosedPosition(p, marketName) {
    const bd = p.realisedPnlBreakdown || p.realizedPnlBreakdown || {};
    const openFees = Number(bd.openFees || 0);
    const closeFees = Number(bd.closeFees || 0);
    const market = String(p.market || marketName);
    return {
      id: String(p.id),
      market,
      marketId: this.marketIdForName(market),
      side: String(p.side || '').toUpperCase() === 'SHORT' ? 'short' : 'long',
      size: Number(p.size || p.maxPositionSize || 0),
      openPrice: Number(p.openPrice || 0),
      exitPrice: Number(p.exitPrice || 0),
      realizedPnl: Number(p.realisedPnl ?? p.realizedPnl ?? 0),
      fees: openFees + closeFees,
      fundingFees: Number(bd.fundingFees || 0),
      closedTime: Number(p.closedTime || 0),
      exitType: p.exitType || null,
    };
  }

  /** 拉取已平仓位并汇总（与 Extended 官网 positions/history 一致） */
  async fetchClosedPositions(marketNames) {
    const out = [];
    for (const name of marketNames) {
      let cursor;
      for (let page = 0; page < 50; page++) {
        const { data, pagination } = await this.getPositionsHistoryPage(name, { cursor, limit: 100 });
        for (const p of data || []) {
          if (!Number(p.closedTime || 0)) continue;
          out.push(this._mapClosedPosition(p, name));
        }
        const next = pagination?.cursor;
        if (!data?.length || next == null || String(next) === String(cursor)) break;
        cursor = next;
      }
    }
    out.sort((a, b) => b.closedTime - a.closedTime);
    return out;
  }

  // ---------- market data ----------
  async getMarkets() { return [...this.markets.values()]; }

  _market(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m) throw new Error('未知市场 marketId=' + marketId);
    return m;
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const m = this._market(marketId);
    const interval = INTERVALS[intervalSec] || 'PT1H';
    const data = await this._get(`/api/v1/info/candles/${encodeURIComponent(m.name)}/trades?interval=${interval}&limit=${Math.min(n, 1000)}`);
    return (data || [])
      .map((c) => ({ time: Number(c.T), open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +(c.v ?? 0) }))
      .filter((c) => Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
  }

  async getPrice(marketId) {
    const mId = Number(marketId);
    this._watch.add(mId);
    const m = this._market(mId);
    try {
      const book = await this._get(`/api/v1/info/markets/${encodeURIComponent(m.name)}/orderbook`);
      const bid = Number(book?.bid?.[0]?.price), ask = Number(book?.ask?.[0]?.price);
      if (bid && ask) { const mid = (bid + ask) / 2; this._prices.set(mId, mid); return mid; }
      if (bid || ask) { const px = bid || ask; this._prices.set(mId, px); return px; }
    } catch { /* fall back */ }
    return this._prices.get(mId) ?? m.lastPrice;
  }

  // ---------- trading ----------
  async setLeverage(marketId, x) {
    const m = this._market(marketId);
    try {
      await this._req('PATCH', '/api/v1/user/leverage', { market: m.name, leverage: String(x) });
      return true;
    } catch (e) { this.emit('error', e); return false; }
  }

  /** Build, sign and submit an order. Returns { orderId }. */
  async _submitOrder(m, { side, qtyStr, priceStr, type, timeInForce, postOnly, reduceOnly }) {
    const isBuy = side === 'buy';
    const amounts = settlementAmounts({
      qty: qtyStr, price: priceStr, feeRate: this.feeRate,
      synRes: m.l2.synRes, colRes: m.l2.colRes, isBuy,
    });
    const nonce = Math.floor(Math.random() * 0xFFFFFFFF);
    const expiryEpochMillis = Date.now() + ORDER_EXPIRY_DAYS * 86400_000;
    const expirationSec = Math.ceil(expiryEpochMillis / 1000) + SETTLEMENT_BUFFER_DAYS * 86400;
    const synId = BigInt(m.l2.syntheticId), colId = BigInt(m.l2.collateralId);
    const hash = orderMsgHash({
      positionId: this.vault,
      baseAssetId: synId, baseAmount: amounts.syntheticAmount,
      quoteAssetId: colId, quoteAmount: amounts.collateralAmount,
      feeAssetId: colId, feeAmount: amounts.feeAmount,
      expirationSec, salt: nonce, publicKey: this.publicKey, domain: this.domain,
    });
    const { r, s } = starkSign(hash, this.privateKey);
    const payload = {
      id: hash.toString(10),
      market: m.name,
      type,
      side: isBuy ? 'BUY' : 'SELL',
      qty: qtyStr,
      price: priceStr,
      reduceOnly: !!reduceOnly,
      postOnly: !!postOnly,
      timeInForce,
      expiryEpochMillis,
      fee: this.feeRate,
      nonce: String(nonce),
      selfTradeProtectionLevel: 'ACCOUNT',
      settlement: {
        signature: { r: toHex(r), s: toHex(s) },
        starkKey: toHex(this.publicKey),
        collateralPosition: String(this.vault),
      },
    };
    const data = await this._req('POST', '/api/v1/user/order', payload);
    return { orderId: String(data?.id ?? payload.id) };
  }

  async placeLimitOrder(o) {
    const m = this._market(o.marketId);
    const qtyStr = alignToStep(o.sizeBase, m.qtyStep, 'down');
    const priceStr = alignToStep(o.price, m.priceStep, 'nearest');
    if (parseDec(qtyStr).i <= 0n) throw new Error('数量过小，低于市场最小下单单位。');
    const { orderId } = await this._submitOrder(m, {
      side: o.side, qtyStr, priceStr, type: 'LIMIT', timeInForce: 'GTT',
      postOnly: o.postOnly ?? true, reduceOnly: !!o.reduceOnly,
    });
    this._watch.add(m.marketId);
    this._tracked.set(orderId, {
      marketId: m.marketId, levelIndex: o.levelIndex, side: o.side,
      price: Number(priceStr), sizeBase: Number(qtyStr), seen: false, reduceOnly: !!o.reduceOnly,
    });
    return { orderId };
  }

  async cancelOrder(marketId, orderId) {
    this._tracked.delete(String(orderId));
    return this._req('DELETE', `/api/v1/user/order/${orderId}`);
  }

  async cancelAll(marketId) {
    const m = this._market(marketId);
    for (const [id, o] of this._tracked) if (o.marketId === m.marketId) this._tracked.delete(id);
    try { return await this._req('POST', '/api/v1/user/order/massCancel', { markets: [m.name] }); }
    catch (e) { this.emit('error', e); return false; }
  }

  getOpenOrders(marketId) {
    return this.getOpenOrdersForMarket(marketId);
  }

  getPosition(marketId) {
    const p = this._pos.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  _parsePosition(p) {
    const name = p.market || p.marketName || p.symbol;
    if (!name) return null;
    const short = String(p.side || '').toUpperCase() === 'SHORT';
    const qty = Math.abs(Number(p.size || p.qty || 0));
    if (!(qty > 0)) return null;
    const mark = Number(p.markPrice ?? p.indexPrice ?? p.marketPrice ?? 0);
    const entry = Number(p.openPrice ?? p.entryPrice ?? 0);
    const value = Number(p.value ?? p.notional ?? 0) || (mark > 0 ? qty * mark : entry * qty);
    let pct = Number(p.unrealisedPnlRatio ?? p.unrealizedPnlRatio ?? p.unrealisedPnlPercent ?? 0);
    if (pct !== 0 && Math.abs(pct) <= 1) pct *= 100;
    return {
      market: name,
      marketId: this.marketIdForName(name),
      side: short ? 'short' : 'long',
      size: qty,
      sizeBase: qty * (short ? -1 : 1),
      entryPrice: entry,
      markPrice: mark,
      valueUsd: Math.round(value * 100) / 100,
      unrealizedPnl: Number(p.unrealisedPnl ?? p.unrealizedPnl ?? 0),
      realizedPnl: Number(p.realisedPnl ?? p.realizedPnl ?? 0),
      unrealizedPct: Math.round(pct * 100) / 100,
      leverage: p.leverage != null ? Number(p.leverage) : null,
      margin: p.margin != null ? Number(p.margin) : (p.initialMargin != null ? Number(p.initialMargin) : null),
      liquidationPrice: p.liquidationPrice != null ? Number(p.liquidationPrice) : null,
    };
  }

  /** 拉取账户全部持仓（不限于当前网格 watch 列表） */
  async _refreshAllPositions() {
    try {
      const ps = await this._get('/api/v1/user/positions');
      const list = Array.isArray(ps) ? ps : (ps ? [ps] : []);
      const parsed = [];
      for (const p of list) {
        const row = this._parsePosition(p);
        if (!row) continue;
        parsed.push(row);
        if (row.marketId) {
          this._pos.set(row.marketId, {
            sizeBase: row.sizeBase,
            entryPrice: row.entryPrice,
            unrealizedPnl: row.unrealizedPnl,
            leverage: row.leverage,
          });
        }
      }
      parsed.sort((a, b) => Math.abs(b.valueUsd) - Math.abs(a.valueUsd));
      this._allPositions = parsed;
    } catch { /* 保留上次快照 */ }
  }

  getAllPositions() {
    return (this._allPositions || []).map((p) => ({ ...p }));
  }

  _parseOpenOrder(o) {
    const market = String(o.market || o.marketName || '');
    const id = String(o.id);
    const tracked = this._tracked.get(id);
    const sideRaw = String(o.side || '').toUpperCase();
    const side = sideRaw === 'SELL' ? 'sell' : 'buy';
    const price = Number(o.price ?? o.averagePrice ?? 0);
    const qty = Number(o.qty ?? o.size ?? 0);
    const filled = Number(o.filledQty ?? 0);
    return {
      orderId: id,
      market,
      marketId: this.marketIdForName(market),
      side,
      price,
      sizeBase: qty > 0 ? qty : filled,
        reduceOnly: tracked?.reduceOnly ?? !!o.reduceOnly,
      type: String(o.type || 'LIMIT').toUpperCase(),
      status: String(o.status || 'NEW').toUpperCase(),
      levelIndex: tracked?.levelIndex ?? null,
    };
  }

  /** 拉取账户全部未成交挂单（与 Extended 官网 orders 一致） */
  async _refreshAllOpenOrders() {
    try {
      const raw = await this._get('/api/v1/user/orders');
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const open = [];
      for (const o of list) {
        const st = String(o.status || 'NEW').toUpperCase();
        if (/FILLED|CANCELLED|REJECTED|EXPIRED/.test(st)) continue;
        const row = this._parseOpenOrder(o);
        if (row.market) open.push(row);
      }
      open.sort((a, b) => b.price - a.price);
      this._allOpenOrders = open;
      for (const row of open) {
        const t = this._tracked.get(row.orderId);
        if (t) t.seen = true;
      }
    } catch { /* 保留上次快照 */ }
  }

  getAllOpenOrders() {
    return (this._allOpenOrders || []).map((o) => ({ ...o }));
  }

  getOpenOrdersForMarket(marketId) {
    const id = Number(marketId);
    const out = this.getAllOpenOrders().filter((o) => o.marketId === id);
    const seen = new Set(out.map((o) => o.orderId));
    for (const [orderId, t] of this._tracked) {
      if (t.marketId !== id || seen.has(orderId)) continue;
      out.push({
        orderId,
        marketId: id,
        side: t.side,
        price: t.price,
        sizeBase: t.sizeBase,
        levelIndex: t.levelIndex ?? null,
        reduceOnly: !!t.reduceOnly,
        type: 'LIMIT',
      });
      seen.add(orderId);
    }
    out.sort((a, b) => b.price - a.price);
    return out;
  }

  /** Close the current position with a reduce-only IOC market order. */
  async closePosition(marketId) {
    const m = this._market(marketId);
    const p = this._pos.get(m.marketId);
    if (!p || !p.sizeBase) return true;
    const isBuy = p.sizeBase < 0; // closing a short buys back
    const last = this._prices.get(m.marketId) || p.entryPrice;
    const worst = last * (isBuy ? 1.05 : 0.95); // worst accepted price
    const qtyStr = alignToStep(Math.abs(p.sizeBase), m.qtyStep, 'down');
    const priceStr = alignToStep(worst, m.priceStep, 'nearest');
    return this._submitOrder(m, {
      side: isBuy ? 'buy' : 'sell', qtyStr, priceStr,
      type: 'MARKET', timeInForce: 'IOC', postOnly: false, reduceOnly: true,
    });
  }

  // ---------- polling ----------
  start() { if (!this._timer) { this._timer = setInterval(() => this._poll(), this.pollMs); this._timer.unref?.(); } }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async _poll() {
    if (this._busy) return; this._busy = true;
    try {
      for (const mId of this._watch) {
        const m = this.markets.get(mId);
        if (!m) continue;
        // price (also emitted for the dashboard)
        this.getPrice(mId).then((px) => { if (px) this.emit('price', { marketId: mId, price: px }); }).catch(() => {});
        // open orders -> fill detection
        let open = null;
        try { open = await this._get(`/api/v1/user/orders?market=${encodeURIComponent(m.name)}`); } catch { /* keep */ }
        if (open) {
          const liveIds = new Set(open.map((o) => String(o.id)));
          for (const o of open) { const t = this._tracked.get(String(o.id)); if (t) t.seen = true; }
          for (const [id, t] of [...this._tracked]) {
            if (t.marketId !== mId) continue;
            if (t.seen && !liveIds.has(id)) {
              this._tracked.delete(id);
              this._resolveGone(id, t).catch(() => {});
            }
          }
        }
        // position
        try {
          const ps = await this._get(`/api/v1/user/positions?market=${encodeURIComponent(m.name)}`);
          const p = (ps || [])[0];
          if (p && Number(p.size)) {
            const short = String(p.side).toUpperCase() === 'SHORT';
            const size = Math.abs(Number(p.size)) * (short ? -1 : 1);
            this._pos.set(mId, {
              sizeBase: size, entryPrice: Number(p.openPrice),
              unrealizedPnl: Number(p.unrealisedPnl ?? 0),
              leverage: p.leverage != null ? Number(p.leverage) : null,
            });
          } else { this._pos.delete(mId); }
        } catch { /* keep last */ }
      }
      await this._refreshAccount().catch(() => {});
      await this._refreshAllPositions().catch(() => {});
      await this._refreshAllOpenOrders().catch(() => {});
      this._refreshOfficialStats().catch(() => {});
    } catch (e) { this.emit('error', e); }
    finally { this._busy = false; }
  }

  /** A tracked order disappeared from the book: filled or cancelled? */
  async _resolveGone(id, t) {
    let filled = true; // default: assume filled (safer for the grid to re-quote)
    try {
      const o = await this._get(`/api/v1/user/orders/${id}`);
      if (o && Number(o.filledQty || 0) === 0 && /CANCELLED|REJECTED|EXPIRED/i.test(String(o.status))) filled = false;
    } catch { /* order lookup failed: keep default */ }
    if (filled) {
      this.emit('fill', { orderId: id, marketId: t.marketId, side: t.side, price: t.price, sizeBase: t.sizeBase, levelIndex: t.levelIndex });
    } else {
      this.emit('cancel', { orderId: id, marketId: t.marketId });
    }
  }

  async _refreshAccount() {
    try {
      const b = await this._get('/api/v1/user/balance');
      if (b) {
        this.balance = Number(b.balance);
        this.equity = Number(b.equity);
        this.unrealisedPnl = Number(b.unrealisedPnl ?? b.unrealizedPnl ?? 0);
        this.availableForTrade = Number(b.availableForTrade ?? b.balance);
      }
    } catch (e) {
      if (/401/.test(e.message)) throw e;       // bad API key: surface it
      if (/404/.test(e.message)) this.balance = 0; // balance endpoint 404s when balance is 0
      /* otherwise keep last known balance */
    }
  }

  /** Extended 官网「交易表现」累计 PnL（portfolio charts，与 app 一致） */
  async _ensureAccountId() {
    if (this._accountId != null) return this._accountId;
    try {
      const info = await this._get('/api/v1/user/account/info');
      if (info?.accountId != null) {
        this._accountId = Number(info.accountId);
        return this._accountId;
      }
    } catch { /* retry via accounts list */ }
    try {
      const list = await this._get('/api/v1/user/accounts');
      const accounts = Array.isArray(list) ? list : [];
      const byVault = accounts.find((a) => Number(a.l2Vault) === this.vault);
      const pick = byVault ?? accounts[0];
      if (pick?.accountId != null) {
        this._accountId = Number(pick.accountId);
        return this._accountId;
      }
    } catch { /* keep null */ }
    return null;
  }

  _parsePortfolioValue(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  _filterPortfolioRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const since = this.pnlSinceDate;
    if (!since) return rows;
    return rows.filter((r) => r.date >= since);
  }

  _sumPortfolioSeries(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    let sum = 0;
    for (const r of rows) {
      const v = this._parsePortfolioValue(r?.value);
      if (v != null) sum += v;
    }
    return Math.round(sum * 1e6) / 1e6;
  }

  /** Extended portfolio 曲线：interval=ALL 时每行是当日盈亏，累计 = 各行求和（与官网交易表现一致） */
  async _fetchPortfolioPnlSeries(pnlType, interval = 'ALL') {
    const accountId = await this._ensureAccountId();
    if (accountId == null) return [];
    const qs = new URLSearchParams({
      accountId: String(accountId),
      interval,
      pnlType,
    });
    const j = await this._req('GET', `/api/v1/portfolio/charts/pnl?${qs}`, undefined, { full: true });
    return Array.isArray(j?.data) ? j.data : [];
  }

  async _fetchPortfolioPnlLatest(pnlType) {
    const rows = await this._fetchPortfolioPnlSeries(pnlType);
    if (!rows.length) return null;
    return this._sumPortfolioSeries(rows);
  }

  _statsMarketNamesExpanded(base = this.statsMarketNames) {
    const fromPos = (this._allPositions || []).map((p) => p.market);
    return [...new Set([...(base || []), ...fromPos])];
  }

  /** Extended 官网口径：交易表现 portfolio + positions/history 明细 */
  async _refreshOfficialStats(marketNames = this.statsMarketNames) {
    const curEquity = typeof this.equity === 'number' ? this.equity : null;
    const cache = this._statsCache;
    const equityJump = cache?.equity != null && curEquity != null && Math.abs(curEquity - cache.equity) >= 1;
    if (cache && Date.now() - cache.ts < 120_000 && !equityJump) return cache;
    await this._refreshAllPositions().catch(() => {});
    const scanMarkets = this._statsMarketNamesExpanded(marketNames);
    let feesPaid = 0;
    let volume = 0;
    const byMarket = {};
    try {
      const trades = await this.fetchAllTrades(scanMarkets);
      for (const t of trades) {
        feesPaid += Number(t.fee || 0);
        volume += Math.abs(Number(t.value || 0));
      }
    } catch { /* keep */ }

    let historyRealized = 0;
    let openRealized = 0;
    let positionFees = 0;
    const closed = [];
    try {
      openRealized = (this._allPositions || []).reduce((s, p) => s + (p.realizedPnl || 0), 0);
    } catch { /* keep */ }
    try {
      const rows = await this.fetchAllClosedPositions();
      for (const p of rows) {
        historyRealized += p.realizedPnl;
        positionFees += p.fees;
        if (!byMarket[p.market]) byMarket[p.market] = { realizedPnl: 0, fees: 0, count: 0 };
        byMarket[p.market].realizedPnl += p.realizedPnl;
        byMarket[p.market].fees += p.fees;
        byMarket[p.market].count++;
      }
      closed.push(...rows);
    } catch { /* keep */ }
    const accountRealized = historyRealized + openRealized;

    let portfolioTotalSeries = [];
    let portfolioRealizedSeries = [];
    let portfolioTotalPnl = null;
    let portfolioRealizedPnl = null;
    try {
      portfolioTotalSeries = await this._fetchPortfolioPnlSeries('TOTAL_PNL');
      portfolioRealizedSeries = await this._fetchPortfolioPnlSeries('REALISED_PNL');
      portfolioTotalPnl = this._sumPortfolioSeries(this._filterPortfolioRows(portfolioTotalSeries));
      portfolioRealizedPnl = this._sumPortfolioSeries(this._filterPortfolioRows(portfolioRealizedSeries));
    } catch { /* keep */ }

    this._statsCache = {
      ts: Date.now(),
      equity: curEquity,
      realizedPnl: accountRealized,
      historyRealized,
      openRealized,
      portfolioTotalSeries,
      portfolioRealizedSeries,
      portfolioTotalPnl,
      portfolioRealizedPnl,
      feesPaid,
      positionFees,
      volume,
      byMarket,
      allClosed: closed,
      recentClosed: closed.slice(0, 50),
    };
    return this._statsCache;
  }

  getOfficialStats() {
    if (!this._statsCache) return null;
    const s = this._statsCache;
    const unrealizedPnl = typeof this.unrealisedPnl === 'number' ? this.unrealisedPnl : null;

    // 官网交易表现：portfolio 每日盈亏求和（勿取最后一天、勿用平仓历史加总）
    let totalPnl = s.portfolioTotalPnl;
    let realizedPnl = s.portfolioRealizedPnl;
    let pnlSource = 'portfolio';

    if (totalPnl == null && realizedPnl != null && unrealizedPnl != null) {
      totalPnl = Math.round((realizedPnl + unrealizedPnl) * 100) / 100;
    }
    if (totalPnl == null && realizedPnl != null) totalPnl = realizedPnl;
    if (realizedPnl == null && totalPnl != null && unrealizedPnl != null) {
      realizedPnl = Math.round((totalPnl - unrealizedPnl) * 100) / 100;
    } else if (totalPnl != null && unrealizedPnl != null) {
      realizedPnl = Math.round((totalPnl - unrealizedPnl) * 100) / 100;
    }

    return {
      realizedPnl,
      unrealizedPnl,
      totalPnl,
      portfolioTotalPnl: s.portfolioTotalPnl,
      portfolioRealizedPnl: s.portfolioRealizedPnl,
      pnlSource,
      feesPaid: s.feesPaid,
      positionFees: s.positionFees,
      volume: s.volume,
      byMarket: s.byMarket,
      allClosed: s.allClosed || s.recentClosed || [],
      recentClosed: s.recentClosed,
      updatedAt: s.ts,
    };
  }

  /** @deprecated use getOfficialStats */
  getTradeStats() {
    const o = this.getOfficialStats();
    if (!o) return null;
    return { fees: o.feesPaid, volume: o.volume };
  }
}
