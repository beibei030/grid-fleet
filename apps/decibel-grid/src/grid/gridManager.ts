import { config } from "../config.js";
import { getCachedDecGridRemoteState } from "../core/decibelGridProxy.js";
import { getCachedOndoGridRemoteState } from "../core/ondoGridProxy.js";
import type { Exchanges } from "../exchanges/index.js";
import type { DecibelExchange } from "../exchanges/decibelExchange.js";
import type { OndoExchange } from "../exchanges/ondoExchange.js";
import { log } from "../util/logger.js";
import { store } from "../core/store.js";
import { DecGridExchange } from "./exchanges/decGridExchange.js";
import { OndoGridExchange } from "./exchanges/ondoGridExchange.js";
import { buildFleetPlans } from "./fleetPlan.js";
import { restartFleet, startFleetMaintainer, startFleetIdleWatchdog, maintainFleet, convergeOverflowGrids } from "./fleetRestart.js";
import { invalidateScannerCache, pickActiveSelectionsValidated, scoreCandidates } from "./fleetScanner.js";
import { GridFleet, type GridFleetState } from "./gridFleet.js";
import { GridJournal } from "./gridJournal.js";
import { analyzeTrend } from "./trend.js";
import { getVenueFleetProfile, mergeVenueProfileFromEnv } from "./venueFleetProfile.js";

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

export class VenueGridManager {
  readonly name: string;
  readonly exchangeLabel: string;
  enabled: boolean;
  slots: number;
  candidates: string[];
  preferSymbols: string[];
  fleet: GridFleet | null = null;
  journal: GridJournal | null = null;
  private adapter: DecGridExchange | OndoGridExchange | null = null;
  private maintainerTimer: ReturnType<typeof setInterval> | null = null;
  private idleWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  readonly fleetProfile;

  constructor(
    name: string,
    exchangeLabel: string,
    enabled: boolean,
    slots: number,
    candidates: string,
    preferSymbols: string
  ) {
    this.name = name;
    this.exchangeLabel = exchangeLabel;
    this.enabled = enabled;
    this.slots = slots;
    this.candidates = parseList(candidates);
    this.preferSymbols = parseList(preferSymbols);
    if (name === "ondo") {
      this.fleetProfile = mergeVenueProfileFromEnv(getVenueFleetProfile("ondo"), {
        budgetUse: config.ondoGrid.budgetUse,
        rangeMinHalfPct: config.ondoGrid.rangeMinHalfPct,
        rangeMaxHalfPct: config.ondoGrid.rangeMaxHalfPct,
        leverage: config.ondoGrid.leverage,
        gridCount: config.ondoGrid.gridCount,
        postOnlyTickOffset: config.ondoGrid.postOnlyTickOffset,
        skipBand: config.ondoGrid.skipBand,
      });
    } else if (name === "dec") {
      this.fleetProfile = mergeVenueProfileFromEnv(getVenueFleetProfile("dec"), {
        leverage: config.decGrid.leverage,
        gridCount: config.decGrid.gridCount,
        rangeMinHalfPct: config.decGrid.rangeHalfPct,
        rangeMaxHalfPct: config.decGrid.rangeHalfPct,
      });
    } else {
      this.fleetProfile = getVenueFleetProfile(name);
    }
  }

  private fleetOpts() {
    return {
      slotCount: this.slots,
      candidateNames: this.candidates,
      preferSymbols: this.preferSymbols,
      exchangeLabel: this.exchangeLabel,
      profile: this.fleetProfile,
    };
  }

  get exchangeAdapter(): DecGridExchange | OndoGridExchange | null {
    return this.adapter;
  }

  get gridFleet(): GridFleet | null {
    return this.fleet;
  }

  fleetOptsPublic() {
    return this.fleetOpts();
  }

  getExchangeAdapter() {
    return this.adapter;
  }

  async init(ex: Exchanges): Promise<void> {
    if (!this.enabled) return;
    this.journal = new GridJournal(this.name);
    await this.journal.load();

    if (this.name === "dec") {
      this.adapter = new DecGridExchange(ex.decibel as DecibelExchange, 3000);
    } else {
      this.adapter = new OndoGridExchange(ex.ondo as OndoExchange, 3000, this.fleetProfile.postOnlyTickOffset);
    }
    await this.adapter.init();
    this.adapter.start();
    this.fleet = new GridFleet(this.adapter, this.journal);
    this.fleet.fleetMeta = {
      exchange: this.exchangeLabel,
      activeSlots: this.slots,
      candidatePool: this.candidates,
      preferSymbols: this.preferSymbols,
      autoRecenter: true,
    };
    log.info(`[Grid/${this.exchangeLabel}] 适配器就绪`);
  }

  startMaintainer(): void {
    if (!this.fleet || !this.adapter || this.maintainerTimer) return;
    const opts = this.fleetOpts();
    this.maintainerTimer = startFleetMaintainer(this.fleet, this.adapter, opts);
    if (!this.idleWatchdogTimer) {
      this.idleWatchdogTimer = startFleetIdleWatchdog(this.fleet, this.adapter, opts);
    }
  }

  async autostart(): Promise<void> {
    if (!this.enabled || !this.fleet || !this.adapter) return;

    let balance =
      this.adapter.equity != null && this.adapter.equity > 0
        ? this.adapter.equity
        : this.adapter.balance;
    for (let i = 0; i < 6 && !(balance != null && balance > 0); i++) {
      await new Promise((r) => setTimeout(r, 5000));
      balance =
        this.adapter.equity != null && this.adapter.equity > 0
          ? this.adapter.equity
          : this.adapter.balance;
    }
    if (!(balance != null && balance > 0)) {
      log.warn(`[Grid/${this.exchangeLabel}] 余额不可用，跳过 autostart`);
      return;
    }

    const st = this.fleet.getState();
    if (st.running && (st.openOrders ?? 0) > 0) {
      await maintainFleet(this.fleet, this.adapter, this.fleetOpts()).catch(() => null);
      return;
    }

    const r = await restartFleet(this.fleet, this.adapter, this.journal, {
      ...this.fleetOpts(),
      closeFirst: false,
    });
    this.startMaintainer();
    await maintainFleet(this.fleet, this.adapter, this.fleetOpts()).catch(() => null);

    const after = this.fleet.getState();
    const started = (r.started as { name?: string; error?: string; openOrders?: number }[]) ?? [];
    const failed = started.filter((x) => x.error);
    if (failed.length) {
      log.warn(
        `[Grid/${this.exchangeLabel}] 部分 bot 启动失败: ${failed.map((x) => `${x.name}:${x.error}`).join("; ")}`
      );
    }
    if (!after.running || (after.openOrders ?? 0) === 0) {
      throw new Error(
        failed.length
          ? `网格未挂上单（${failed.map((x) => x.error).join("；")}）`
          : "网格启动后无挂单，请检查余额或重试「按余额重配」"
      );
    }
    log.info(
      `[Grid/${this.exchangeLabel}] autostart 完成 | bots=${after.botCount} | 挂单=${after.openOrders}`
    );
  }

  async restart(closeFirst = true) {
    if (!this.fleet || !this.adapter) throw new Error("网格未启用");
    invalidateScannerCache();
    const r = await restartFleet(this.fleet, this.adapter, this.journal, {
      ...this.fleetOpts(),
      closeFirst,
    });
    this.startMaintainer();
    return r;
  }

  /** 立即收敛超量/重复挂单（撤单后以现价重挂） */
  async converge() {
    if (!this.fleet || !this.adapter) throw new Error("网格未启用");
    const r = await convergeOverflowGrids(this.fleet, this.adapter, this.exchangeLabel);
    return r;
  }

  async scan() {
    if (!this.adapter) throw new Error("网格未启用");
    const rows = await scoreCandidates(this.adapter, {
      names: this.candidates,
      preferSymbols: this.preferSymbols,
      profile: this.fleetProfile,
    });
    return { rows, candidatePool: this.candidates, slots: this.slots };
  }

  async plan() {
    if (!this.adapter || !this.fleet) throw new Error("网格未启用");
    const balance = this.adapter.balance ?? this.adapter.equity;
    if (balance == null) throw new Error("读不到账户余额");
    const markets = await this.adapter.getMarkets();
    const selections = await pickActiveSelectionsValidated(this.adapter, {
      slotCount: this.slots,
      names: this.candidates,
      preferSymbols: this.preferSymbols,
      runningMarketIds: this.fleet.runningMarketIds(),
      balance,
      markets,
      profile: this.fleetProfile,
    });
    const preview = buildFleetPlans({ balance, markets, selections, profile: this.fleetProfile });
    return { preview, selections, balance };
  }

  async trend(symbol: string) {
    if (!this.adapter) throw new Error("网格未启用");
    const sym = symbol.trim().toUpperCase();
    const markets = await this.adapter.getMarkets();
    const m = markets.find(
      (x) =>
        x.symbol.toUpperCase() === sym ||
        x.displayName.toUpperCase() === sym ||
        x.displayName.toUpperCase().startsWith(`${sym}-`)
    );
    if (!m) throw new Error(`未找到标的 ${sym}`);
    const candles = await this.adapter.getCandles(m.marketId, 900, 96);
    return { symbol: sym, market: m.displayName, analysis: analyzeTrend(candles), candleCount: candles.length };
  }

  resetRoundBaseline() {
    if (!this.fleet || !this.adapter) throw new Error("网格未启用");
    const eq = this.adapter.equity ?? this.adapter.balance;
    if (eq == null || !(eq > 0)) throw new Error("读不到当前权益");
    this.journal?.resetBaseline(eq);
    return this.fleet.getState();
  }

  getState(): GridFleetState | null {
    if (!this.fleet) {
      return {
        exchange: this.exchangeLabel,
        mode: "idle",
        running: false,
        botCount: 0,
        bots: [],
        livePositions: [],
        balance: null,
        equity: null,
        volume: 0,
        openOrders: 0,
        openOrdersList: [],
        stats: { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 },
        gridProfit: 0,
        feesPaid: null,
        baselineEquity: null,
        baselineSetAt: null,
        official: null,
        realizedPnl: null,
        totalPnl: null,
        unrealizedPnl: 0,
        accountPnl: null,
        returnPct: null,
        recentClosed: [],
        fills: [],
        alerts: [],
        journalPersisted: false,
        fleetMeta: {
          exchange: this.exchangeLabel,
          enabled: this.enabled,
          candidatePool: this.candidates,
          preferSymbols: this.preferSymbols,
          activeSlots: this.slots,
          paused: false,
        },
        config: null,
        grid: null,
        lastPrice: null,
        outOfRange: false,
        risk: null,
        openByLevel: {},
        position: null,
      } as GridFleetState;
    }
    return this.fleet.getState();
  }

  async stopAll(closePosition = true): Promise<void> {
    if (!this.fleet) return;
    await this.fleet.stop({ closePosition });
    this.adapter?.stop();
  }

  tickRespectKillSwitch(): void {
    if (!store.get().killSwitch || !this.fleet) return;
    const st = this.fleet.getState();
    if (st.running) {
      void this.fleet.stop({ closePosition: false }).catch(() => {});
    }
  }
}

export const decGridManager = new VenueGridManager(
  "dec",
  "Decibel",
  config.decGrid.enabled,
  config.decGrid.slots,
  config.decGrid.candidates,
  config.decGrid.preferSymbols
);

export const ondoGridManager = new VenueGridManager(
  "ondo",
  "Ondo",
  config.ondoGrid.enabled,
  config.ondoGrid.slots,
  config.ondoGrid.candidates,
  config.ondoGrid.preferSymbols
);

export async function initGridManagers(ex: Exchanges): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (!config.decGrid.standalone) tasks.push(decGridManager.init(ex));
  if (!config.ondoGrid.standalone) tasks.push(ondoGridManager.init(ex));
  await Promise.all(tasks);
  if (!config.decGrid.standalone && config.decGrid.autostart) await decGridManager.autostart();
  if (!config.ondoGrid.standalone && config.ondoGrid.autostart) await ondoGridManager.autostart();
  if (!config.decGrid.standalone) decGridManager.startMaintainer();
  if (!config.ondoGrid.standalone) ondoGridManager.startMaintainer();
}

export async function stopAllGridFleets(closePosition = true): Promise<void> {
  const stops: Promise<void>[] = [];
  if (!config.decGrid.standalone) stops.push(decGridManager.stopAll(closePosition));
  if (!config.ondoGrid.standalone) stops.push(ondoGridManager.stopAll(closePosition));
  await Promise.all(stops);
}

export function tickGridManagers(): void {
  if (!config.decGrid.standalone) decGridManager.tickRespectKillSwitch();
  if (!config.ondoGrid.standalone) ondoGridManager.tickRespectKillSwitch();
}

/** 运行中 GridBot 的持仓计入「已跟踪」，避免被误判为 harvest 孤儿仓 */
function trackedKeysFromFleetState(st: GridFleetState | null, exchangeLabel: string): string[] {
  const keys: string[] = [];
  if (!st?.bots?.length) return keys;
  for (const b of st.bots) {
    if (!b.running) continue;
    const cfg = b.config as { symbol?: string; displayName?: string } | null;
    const sym = (cfg?.symbol ?? cfg?.displayName?.split("-")[0] ?? "").toUpperCase();
    if (!sym) continue;
    const pos = b.position as { sizeBase?: number } | null | undefined;
    const sz = pos?.sizeBase ?? 0;
    if (Math.abs(sz) <= 0) continue;
    const side = sz > 0 ? "long" : "short";
    keys.push(`${exchangeLabel}:${sym}:${side}`);
  }
  return keys;
}

export function gridFleetTrackedPositionKeys(): string[] {
  const keys: string[] = [];
  if (config.decGrid.standalone) {
    keys.push(...trackedKeysFromFleetState(getCachedDecGridRemoteState(), "Decibel"));
  } else {
    keys.push(...trackedKeysFromFleetState(decGridManager.getState(), "Decibel"));
  }
  if (config.ondoGrid.standalone) {
    keys.push(...trackedKeysFromFleetState(getCachedOndoGridRemoteState(), "Ondo"));
  } else {
    keys.push(...trackedKeysFromFleetState(ondoGridManager.getState(), "Ondo"));
  }
  return keys;
}

export async function proxyExtendedFleetStop(closePosition = true): Promise<{ ok: boolean; error?: string }> {
  const url = config.gridFleet.url.replace(/\/$/, "");
  const token = config.gridFleet.token;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`${url}/api/stop`, {
      method: "POST",
      headers,
      body: JSON.stringify({ closePosition }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
