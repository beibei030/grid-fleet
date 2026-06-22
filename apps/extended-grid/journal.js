import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const FILE = path.join(ROOT, 'logs', 'grid-journal.json');
const MAX_FILLS = 500;
const MAX_ALERTS = 200;

function round2(x) { return Math.round(x * 100) / 100; }

function emptyData() {
  return {
    version: 1,
    updatedAt: Date.now(),
    baselineEquity: null,
    baselineSetAt: null,
    sessionStartAt: null,
    stats: { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 },
    byMarket: {},
    fills: [],
    alerts: [],
    seenFillIds: [],
  };
}

/** 成交/日志/统计持久化，部署重启不丢记录 */
export class GridJournal {
  constructor() {
    this.data = emptyData();
    this._saveTimer = null;
  }

  async load() {
    try {
      if (!fs.existsSync(path.dirname(FILE))) fs.mkdirSync(path.dirname(FILE), { recursive: true });
      if (!fs.existsSync(FILE)) return;
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      this.data = { ...emptyData(), ...raw };
      if (!Array.isArray(this.data.fills)) this.data.fills = [];
      if (!Array.isArray(this.data.alerts)) this.data.alerts = [];
      if (!Array.isArray(this.data.seenFillIds)) this.data.seenFillIds = [];
      if (!this.data.byMarket) this.data.byMarket = {};
      if (!this.data.stats) this.data.stats = emptyData().stats;
      // 限制 seenFillIds 大小
      if (this.data.seenFillIds.length > 2000) {
        this.data.seenFillIds = this.data.seenFillIds.slice(-2000);
      }
    } catch (e) {
      console.warn('[Journal] 读取失败，使用空记录:', e.message);
      this.data = emptyData();
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 400);
  }

  _saveNow() {
    try {
      if (!fs.existsSync(path.dirname(FILE))) fs.mkdirSync(path.dirname(FILE), { recursive: true });
      this.data.updatedAt = Date.now();
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 0));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.warn('[Journal] 保存失败:', e.message);
    }
  }

  _marketStats(marketId) {
    const k = String(marketId);
    if (!this.data.byMarket[k]) {
      this.data.byMarket[k] = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    }
    return this.data.byMarket[k];
  }

  recordFill({ id: fillId, orderId, marketId, symbol, side, price, sizeBase, levelIndex, gridProfitDelta = 0, completedRung = false, t }) {
    const id = fillId != null ? String(fillId) : (orderId != null ? String(orderId) : `${marketId}-${Date.now()}-${side}-${price}`);
    if (this.data.seenFillIds.includes(id)) return false;
    this.data.seenFillIds.push(id);
    if (this.data.seenFillIds.length > 2000) this.data.seenFillIds.shift();

    const fill = {
      id,
      t: t || Date.now(),
      marketId,
      symbol,
      side,
      price,
      size: sizeBase,
      level: levelIndex ?? null,
    };
    this.data.fills.unshift(fill);
    if (this.data.fills.length > MAX_FILLS) this.data.fills.length = MAX_FILLS;

    const vol = round2(price * sizeBase);
    const st = this.data.stats;
    const ms = this._marketStats(marketId);
    if (side === 'buy') { st.buys++; ms.buys++; } else { st.sells++; ms.sells++; }
    st.volume = round2(st.volume + vol);
    ms.volume = round2(ms.volume + vol);
    if (completedRung) {
      st.completedRungs++;
      ms.completedRungs++;
      st.gridProfit = round2(st.gridProfit + gridProfitDelta);
      ms.gridProfit = round2(ms.gridProfit + gridProfitDelta);
    }
    this._scheduleSave();
    return true;
  }

  recordAlert({ marketId, symbol, message }) {
    this.data.alerts.unshift({ t: Date.now(), marketId, symbol, message });
    if (this.data.alerts.length > MAX_ALERTS) this.data.alerts.length = MAX_ALERTS;
    this._scheduleSave();
  }

  getFills(limit = 80) {
    return this.data.fills.slice(0, limit);
  }

  getAlerts(limit = 40) {
    return this.data.alerts.slice(0, limit);
  }

  getStats() {
    return { ...this.data.stats };
  }

  getMarketStats(marketId) {
    return { ...this._marketStats(marketId) };
  }

  resetSession(equity) {
    const eq = Number(equity);
    const now = Date.now();
    this.data.sessionStartAt = now;
    this.data.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.data.byMarket = {};
    this.data.fills = [];
    this.data.alerts = [];
    // 仅清本地成交统计；权益基准不动，本轮盈亏持续累计
    if (eq > 0) this.ensureBaseline(eq);
    this._saveNow();
    return { sessionStartAt: now, baselineEquity: this.getBaselineEquity() };
  }

  getSessionStartAt() {
    return this.data.sessionStartAt != null ? Number(this.data.sessionStartAt) : null;
  }

  /** 记录权益基准，用于计算真实账户盈亏（较基准权益变化） */
  ensureBaseline(equity, { force = false } = {}) {
    const eq = Number(equity);
    if (!(eq > 0)) return null;
    const envBase = Number(process.env.GRID_BASELINE_EQUITY || 0);
    if (this.data.baselineEquity == null && envBase > 0) {
      this.data.baselineEquity = envBase;
      this.data.baselineSetAt = Date.now();
      this._scheduleSave();
    }
    if (this.data.baselineEquity == null || force) {
      this.data.baselineEquity = eq;
      this.data.baselineSetAt = Date.now();
      this._scheduleSave();
    }
    return this.data.baselineEquity;
  }

  getBaselineEquity() {
    return this.data.baselineEquity != null ? Number(this.data.baselineEquity) : null;
  }

  getBaselineSetAt() {
    return this.data.baselineSetAt != null ? Number(this.data.baselineSetAt) : null;
  }

  /** 运行中 bot 的 session 统计叠加到持久化总量（用于面板展示） */
  mergeStats(sessionAgg) {
    const j = this.data.stats;
    return {
      buys: j.buys + (sessionAgg?.buys || 0),
      sells: j.sells + (sessionAgg?.sells || 0),
      completedRungs: j.completedRungs + (sessionAgg?.completedRungs || 0),
      gridProfit: round2(j.gridProfit + (sessionAgg?.gridProfit || 0)),
      volume: round2(j.volume + (sessionAgg?.volume || 0)),
    };
  }
}
