import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_FILLS = 500;
const MAX_ALERTS = 200;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function emptyData() {
  return {
    version: 1,
    updatedAt: Date.now(),
    baselineEquity: null as number | null,
    baselineSetAt: null as number | null,
    stats: { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 },
    byMarket: {} as Record<string, { buys: number; sells: number; completedRungs: number; gridProfit: number; volume: number }>,
    fills: [] as Record<string, unknown>[],
    alerts: [] as Record<string, unknown>[],
    seenFillIds: [] as string[],
  };
}

export type JournalData = ReturnType<typeof emptyData>;

export class GridJournal {
  private data = emptyData();
  private file: string;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(subdir: string) {
    this.file = path.join(ROOT, "data", "grid-journal", `${subdir}.json`);
  }

  async load(): Promise<void> {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = { ...emptyData(), ...raw };
      if (!Array.isArray(this.data.fills)) this.data.fills = [];
      if (!Array.isArray(this.data.alerts)) this.data.alerts = [];
      if (!Array.isArray(this.data.seenFillIds)) this.data.seenFillIds = [];
      if (!this.data.byMarket) this.data.byMarket = {};
      if (!this.data.stats) this.data.stats = emptyData().stats;
      if (this.data.seenFillIds.length > 2000) {
        this.data.seenFillIds = this.data.seenFillIds.slice(-2000);
      }
    } catch (e: any) {
      console.warn(`[GridJournal] 读取失败 ${this.file}:`, e?.message);
      this.data = emptyData();
    }
  }

  private scheduleSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 400);
  }

  saveNow(): void {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.data.updatedAt = Date.now();
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e: any) {
      console.warn(`[GridJournal] 保存失败:`, e?.message);
    }
  }

  private marketStats(marketId: number) {
    const k = String(marketId);
    if (!this.data.byMarket[k]) {
      this.data.byMarket[k] = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    }
    return this.data.byMarket[k];
  }

  recordFill(params: {
    id?: string;
    orderId?: string;
    marketId: number;
    symbol?: string;
    side: "buy" | "sell";
    price: number;
    sizeBase: number;
    levelIndex?: number;
    gridProfitDelta?: number;
    completedRung?: boolean;
    t?: number;
  }): boolean {
    const id =
      params.id != null
        ? String(params.id)
        : params.orderId != null
          ? String(params.orderId)
          : `${params.marketId}-${Date.now()}-${params.side}-${params.price}`;
    if (this.data.seenFillIds.includes(id)) return false;
    this.data.seenFillIds.push(id);
    if (this.data.seenFillIds.length > 2000) this.data.seenFillIds.shift();

    const fill = {
      id,
      t: params.t || Date.now(),
      marketId: params.marketId,
      symbol: params.symbol,
      side: params.side,
      price: params.price,
      size: params.sizeBase,
      level: params.levelIndex ?? null,
    };
    this.data.fills.unshift(fill);
    if (this.data.fills.length > MAX_FILLS) this.data.fills.length = MAX_FILLS;

    const vol = round2(params.price * params.sizeBase);
    const st = this.data.stats;
    const ms = this.marketStats(params.marketId);
    if (params.side === "buy") {
      st.buys++;
      ms.buys++;
    } else {
      st.sells++;
      ms.sells++;
    }
    st.volume = round2(st.volume + vol);
    ms.volume = round2(ms.volume + vol);
    if (params.completedRung) {
      st.completedRungs++;
      ms.completedRungs++;
      st.gridProfit = round2(st.gridProfit + (params.gridProfitDelta ?? 0));
      ms.gridProfit = round2(ms.gridProfit + (params.gridProfitDelta ?? 0));
    }
    this.scheduleSave();
    return true;
  }

  recordAlert(params: { marketId: number; symbol?: string; message: string }): void {
    const message =
      params.message.length > 160 ? params.message.slice(0, 160) + "…" : params.message;
    if (this.data.alerts[0]?.message === message) return;
    this.data.alerts.unshift({
      t: Date.now(),
      marketId: params.marketId,
      symbol: params.symbol,
      message,
    });
    if (this.data.alerts.length > MAX_ALERTS) this.data.alerts.length = MAX_ALERTS;
    this.scheduleSave();
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

  getMarketStats(marketId: number) {
    return { ...this.marketStats(marketId) };
  }

  ensureBaseline(equity: number, opts: { force?: boolean } = {}): number | null {
    const eq = Number(equity);
    if (!(eq > 0)) return null;
    if (this.data.baselineEquity == null || opts.force) {
      this.data.baselineEquity = eq;
      this.data.baselineSetAt = Date.now();
      this.scheduleSave();
    }
    return this.data.baselineEquity;
  }

  /** 将本轮盈亏基线设为当前权益（排除之前转账/充值） */
  resetBaseline(equity: number): number | null {
    return this.ensureBaseline(equity, { force: true });
  }

  getBaselineEquity(): number | null {
    return this.data.baselineEquity != null ? Number(this.data.baselineEquity) : null;
  }

  getBaselineSetAt(): number | null {
    return this.data.baselineSetAt != null ? Number(this.data.baselineSetAt) : null;
  }
}
