import type { GridExchangeAdapter } from "./iExchange.js";
import type { GridFleet } from "./gridFleet.js";
import type { GridJournal } from "./gridJournal.js";
import { FLEET_DEFAULTS, buildFleetPlans, buildPlanFromSelection, planToBotConfig } from "./fleetPlan.js";
import { invalidateScannerCache, pickActiveSelectionsValidated } from "./fleetScanner.js";
import { isFleetPaused, cancelAccountOpenOrders, closeAllPositions, closeOrphanPositions } from "./fleetControl.js";
import { analyzeTrend } from "./trend.js";
import { log } from "../util/logger.js";
import type { FleetVenueProfile } from "./venueFleetProfile.js";

let fleetRestarting = false;
let fleetRestartingSince = 0;
let fleetRestartReason = "";
let fleetUnderCapacitySince: number | null = null;
let fleetUnderCapacitySoftTried = false;
let fleetZeroOrdersSince: number | null = null;
let fleetRecovering = false;
let lastMaintainError: string | null = null;
let maintainErrorTimestamps: number[] = [];

function recordMaintainError(msg: string): void {
  lastMaintainError = msg;
  const now = Date.now();
  maintainErrorTimestamps.push(now);
  maintainErrorTimestamps = maintainErrorTimestamps.filter((t) => now - t < 3600_000);
  log.warn(`[Grid] maintain: ${msg}`);
}

export function getFleetLockMeta() {
  return {
    restarting: fleetRestarting,
    restartingSince: fleetRestartingSince,
    restartingReason: fleetRestartReason,
    recovering: fleetRecovering,
  };
}

export function getMaintainDiagnostics() {
  const now = Date.now();
  maintainErrorTimestamps = maintainErrorTimestamps.filter((t) => now - t < 3600_000);
  return { lastError: lastMaintainError, errorsLastHour: maintainErrorTimestamps.length };
}

export async function waitForFleetRestartLock(maxWaitMs = 120_000): Promise<boolean> {
  const start = Date.now();
  let delay = 2000;
  while (fleetRestarting && Date.now() - start < maxWaitMs) {
    clearStuckFleetRestart();
    if (!fleetRestarting) return true;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.floor(delay * 1.5), 15_000);
  }
  clearStuckFleetRestart();
  return !fleetRestarting;
}

function clearIdleTimers(): void {
  fleetUnderCapacitySince = null;
  fleetUnderCapacitySoftTried = false;
  fleetZeroOrdersSince = null;
}

function clearStuckFleetRestart(): void {
  if (fleetRestarting && fleetRestartingSince > 0 && Date.now() - fleetRestartingSince > 10 * 60_000) {
    log.warn("[Grid] 舰队重配锁超时，自动释放");
    fleetRestarting = false;
    fleetRestartingSince = 0;
  }
}

export async function restartFleet(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  journal: GridJournal | null,
  opts: {
    slotCount: number;
    candidateNames: string[];
    preferSymbols?: string[];
    closeFirst?: boolean;
    exchangeLabel?: string;
    profile?: FleetVenueProfile;
  }
) {
  if (fleetRestarting) {
    clearStuckFleetRestart();
    if (fleetRestarting) throw new Error("舰队重配进行中，请稍候");
  }
  fleetRestarting = true;
  fleetRestartingSince = Date.now();
  fleetRestartReason = opts.closeFirst ? "restart:closeFirst" : "restart:light";
  try {
  const balance =
    exchange.equity != null && exchange.equity > 0 ? exchange.equity : exchange.balance;
  if (balance == null) throw new Error("读不到账户余额");
  const eq = exchange.equity ?? balance;
  const wasRunning = fleet.getState().running;
  // 冷启动 / 全量重配时重置基准，避免把历史账户回撤算进「本轮盈亏」
  journal?.ensureBaseline(eq, { force: !!opts.closeFirst || !wasRunning });

  const runningIds = fleet.runningMarketIds();
  const markets = await exchange.getMarkets();
  const selections = await pickActiveSelectionsValidated(exchange, {
    slotCount: opts.slotCount,
    names: opts.candidateNames,
    preferSymbols: opts.preferSymbols,
    runningMarketIds: opts.closeFirst ? [] : runningIds,
    balance,
    markets,
    profile: opts.profile,
  });
  const preview = buildFleetPlans({ balance, markets, selections, profile: opts.profile });

  if (opts.closeFirst) {
    await fleet.stop({ closePosition: false });
    await cancelAccountOpenOrders(exchange);
    const flat = await closeAllPositions(exchange).catch((e) => {
      log.warn(`[Grid/${opts.exchangeLabel ?? ""}] 重配前平仓: ${e?.message ?? e}`);
      return { closed: [], count: 0 };
    });
    if (flat.count > 0) {
      log.info(`[Grid/${opts.exchangeLabel ?? ""}] 重配前已平仓 ${flat.count} 个标的`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    const targetIds = new Set(preview.plans.map((p) => p.marketId));
    for (const id of fleet.runningMarketIds()) {
      if (!targetIds.has(id)) {
        await fleet.stop({ marketId: id, closePosition: true });
        fleet.removeBot(id);
      }
    }
  }

  invalidateScannerCache();
  if (opts.closeFirst) {
    await cancelAccountOpenOrders(exchange);
  } else {
    await reconcileUnmanagedOrders(fleet, exchange, opts).catch(() => 0);
  }
  const started: Record<string, unknown>[] = [];
  for (const p of preview.plans) {
    if (fleet.isRunning(p.marketId)) {
      const bot = fleet.bot(p.marketId);
      const botSt = bot.getState();
      const cfg = botSt.config as { gridCount?: number; rangeHalfPct?: number } | null;
      const next = planToBotConfig(p);
      const needsReplan =
        cfg?.gridCount !== next.gridCount ||
        Math.abs((cfg?.rangeHalfPct ?? 0) - (next.rangeHalfPct ?? 0)) > 0.0005;
      if (needsReplan) {
        await fleet.stop({ marketId: p.marketId, closePosition: false });
        fleet.removeBot(p.marketId);
        const restarted = await fleet.start(next);
        started.push({ name: p.name, replanned: true, openOrders: restarted.openOrders, score: p.score });
        log.info(
          `[Grid/${opts.exchangeLabel ?? ""}] ${p.name} 重配网格 ${cfg?.gridCount ?? "?"}→${next.gridCount} 格 · ±${((next.rangeHalfPct ?? 0) * 100).toFixed(1)}%`
        );
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      await reseedBotIfEmptyOrInvalid(fleet, exchange, p.marketId, opts.exchangeLabel);
      started.push({ name: p.name, skipped: true, openOrders: botSt.openOrders ?? 0 });
      continue;
    }
    try {
      await exchange.setLeverage(p.marketId, p.leverage).catch((e) => {
        log.warn(`[Grid/${opts.exchangeLabel ?? ""}] ${p.name} 设杠杆 ${p.leverage}x: ${e?.message ?? e}`);
      });
      const st = await fleet.start(planToBotConfig(p));
      started.push({ name: p.name, openOrders: st.openOrders, score: p.score, perRung: p.perRungUsd, margin: p.estMarginUsd });
      log.trade(
        `[Grid/${opts.exchangeLabel ?? ""}] 启动 ${p.name} 得分${p.score} | 每单~${p.orderNotionalUsd ?? "?"}U · ${p.gridCount}格 · 格距${p.spacingPct}% · 利润~${p.perRungProfitUsd ?? p.perRungUsd}U/格`
      );
    } catch (e: any) {
      started.push({ name: p.name, error: e?.message });
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  return { preview, started, state: fleet.getState() };
  } finally {
    fleetRestarting = false;
    fleetRestartingSince = 0;
    fleetRestartReason = "";
  }
}

export async function maintainFleet(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  opts: { slotCount: number; candidateNames: string[]; preferSymbols?: string[]; exchangeLabel?: string; profile?: FleetVenueProfile }
) {
  if (isFleetPaused()) return { ok: true, action: "paused" };
  const balance =
    exchange.equity != null && exchange.equity > 0 ? exchange.equity : exchange.balance;
  if (balance == null) return { ok: false, reason: "no balance" };

  const now = Date.now();
  const started: { name: string; score?: number }[] = [];

  for (const b of fleet.getState().bots ?? []) {
    if (!b.running) continue;
    if (
      b.outOfRange &&
      b.outOfRangeSince &&
      now - (b.outOfRangeSince as number) > 3 * 3600_000 &&
      (!b.lastRecenterAt || now - (b.lastRecenterAt as number) > 3600_000)
    ) {
      const bot = fleet.bot((b.config as any).marketId);
      await bot.recenter(b.lastPrice as number, { force: true }).catch(() => {});
    }
    const bot = fleet.bot((b.config as any).marketId);
    await bot.ensureGridNearPrice().catch(() => false);
  }

  const runningCount = fleet.runningMarketIds().length;
  if (!isFleetPaused()) {
    await reconcileUnmanagedOrders(fleet, exchange, opts).catch((e) => {
      recordMaintainError(`reconcile: ${(e as Error)?.message ?? e}`);
      return 0;
    });
  }
  if (runningCount > 0) {
    await convergeOverflowGrids(fleet, exchange, opts.exchangeLabel).catch((e) => {
      recordMaintainError(`converge: ${(e as Error)?.message ?? e}`);
      return { converged: [] as string[] };
    });
    await replenishEmptyGrids(fleet, exchange, opts.exchangeLabel).catch((e) => {
      recordMaintainError(`replenish: ${(e as Error)?.message ?? e}`);
      return null;
    });
    for (const id of fleet.runningMarketIds()) {
      const bot = fleet.bot(id);
      if (bot.running) {
        await bot.replenishMaintain().catch((e) => {
          recordMaintainError(`replenishMaintain ${id}: ${(e as Error)?.message ?? e}`);
          return null;
        });
      }
    }
    await closeOrphanPositions(fleet, exchange, opts.exchangeLabel).catch((e) => {
      recordMaintainError(`closeOrphan: ${(e as Error)?.message ?? e}`);
      return 0;
    });
  }
  if (runningCount >= opts.slotCount) {
    return { ok: true, action: "noop", running: runningCount };
  }

  invalidateScannerCache();
  const markets = await exchange.getMarkets();
  const selections = await pickActiveSelectionsValidated(exchange, {
    slotCount: opts.slotCount,
    names: opts.candidateNames,
    preferSymbols: opts.preferSymbols,
    runningMarketIds: fleet.runningMarketIds(),
    balance,
    markets,
    profile: opts.profile,
  });

  for (const sel of selections) {
    if (fleet.runningMarketIds().length >= opts.slotCount) break;
    if (fleet.isRunning(sel.marketId)) continue;
    try {
      const plan = buildPlanFromSelection({ balance, markets, sel: { ...sel, weight: 1 / opts.slotCount }, profile: opts.profile });
      await fleet.start(planToBotConfig(plan));
      started.push({ name: plan.name, score: plan.score });
      log.info(`[Grid/${opts.exchangeLabel}] 补槽 ${plan.name}（得分 ${plan.score}）`);
    } catch (e: any) {
      log.warn(`[Grid/${opts.exchangeLabel}] 补槽 ${sel.name} 失败: ${e?.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  await recoverIdleFleet(fleet, exchange, opts).catch((e) => {
    recordMaintainError(`idleRecover: ${(e as Error)?.message ?? e}`);
    return { recovered: false };
  });

  return { ok: true, action: started.length ? "fill" : "recenter", started, running: fleet.runningMarketIds().length };
}

/** 未暂停但槽位未满 / 在跑无单 → 超时后强制 restartFleet，避免空转一天 */
export async function recoverIdleFleet(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  opts: { slotCount: number; candidateNames: string[]; preferSymbols?: string[]; exchangeLabel?: string; profile?: FleetVenueProfile },
  thresholds = { underCapacitySoftMs: 5 * 60_000, underCapacityHardMs: 10 * 60_000, zeroOrdersMs: 10 * 60_000 }
): Promise<{ recovered: boolean; reason?: string }> {
  if (isFleetPaused() || fleetRecovering) {
    clearIdleTimers();
    return { recovered: false };
  }
  if (fleetRestarting) {
    const ok = await waitForFleetRestartLock(90_000);
    if (!ok) return { recovered: false, reason: "busy_lock" };
  }

  const runningCount = fleet.runningMarketIds().length;
  if (runningCount > 0) {
    const { converged } = await convergeOverflowGrids(fleet, exchange, opts.exchangeLabel).catch(() => ({
      converged: [] as string[],
    }));
    if (converged.length) {
      clearIdleTimers();
      return { recovered: true, reason: `converged:${converged.join(",")}` };
    }
  }
  const st = fleet.getState();
  let totalOo = 0;
  for (const b of st.bots ?? []) {
    if (b.running) totalOo += (b.openOrders as number) || 0;
  }

  if (runningCount >= opts.slotCount && totalOo > 0) {
    const st2 = fleet.getState();
    let hasInvalid = false;
    for (const b of st2.bots ?? []) {
      if (!b.running) continue;
      const mid = (b.config as { marketId?: number })?.marketId;
      if (mid == null) continue;
      const open = exchange.getOpenOrders(mid);
      if (ordersLookInvalid(open, (b.lastPrice as number) ?? 0)) {
        hasInvalid = true;
        break;
      }
    }
    if (!hasInvalid) {
      let detachedEarly = 0;
      for (const id of fleet.runningMarketIds()) {
        if (fleet.bot(id).isOrdersDetachedFromPrice()) detachedEarly++;
      }
      if (detachedEarly > 0 && detachedEarly < runningCount) {
        for (const id of fleet.runningMarketIds()) {
          const b = fleet.bot(id);
          if (b.isOrdersDetachedFromPrice()) {
            await b.ensureGridNearPrice().catch(() => false);
          }
        }
        clearIdleTimers();
        return { recovered: true, reason: "partial_detached" };
      }
    }
  }

  const now = Date.now();
  if (runningCount < opts.slotCount) {
    if (!fleetUnderCapacitySince) {
      fleetUnderCapacitySince = now;
      fleetUnderCapacitySoftTried = false;
    } else if (
      !fleetUnderCapacitySoftTried &&
      now - fleetUnderCapacitySince >= thresholds.underCapacitySoftMs
    ) {
      fleetRecovering = true;
      fleetUnderCapacitySoftTried = true;
      try {
        log.warn(
          `[Grid/${opts.exchangeLabel}] 槽位未满 ${runningCount}/${opts.slotCount}，先 converge/补铺`
        );
        await convergeOverflowGrids(fleet, exchange, opts.exchangeLabel);
        await replenishEmptyGrids(fleet, exchange, opts.exchangeLabel);
        const after = fleet.getState();
        if ((after.botCount ?? 0) >= opts.slotCount) clearIdleTimers();
        return { recovered: true, reason: "under_capacity_soft" };
      } finally {
        fleetRecovering = false;
      }
    } else if (now - fleetUnderCapacitySince >= thresholds.underCapacityHardMs) {
      fleetRecovering = true;
      try {
        log.error(
          `[Grid/${opts.exchangeLabel}] 空转恢复：运行 ${runningCount}/${opts.slotCount} 槽已 ${Math.round((now - fleetUnderCapacitySince) / 60000)} 分钟，强制 restart`
        );
        await restartFleet(fleet, exchange, null, { ...opts, closeFirst: false });
        clearIdleTimers();
        return { recovered: true, reason: "under_capacity" };
      } finally {
        fleetRecovering = false;
      }
    }
    return { recovered: false };
  }

  fleetUnderCapacitySince = null;
  fleetUnderCapacitySoftTried = false;

  if (runningCount > 0 && totalOo === 0) {
    if (!fleetZeroOrdersSince) fleetZeroOrdersSince = now;
    else if (now - fleetZeroOrdersSince >= thresholds.zeroOrdersMs) {
      fleetRecovering = true;
      try {
        log.error(
          `[Grid/${opts.exchangeLabel}] 空转恢复：${runningCount} bot 在跑但 0 挂单已 ${Math.round((now - fleetZeroOrdersSince) / 60000)} 分钟`
        );
        await restartFleet(fleet, exchange, null, { ...opts, closeFirst: false });
        clearIdleTimers();
        return { recovered: true, reason: "zero_orders" };
      } finally {
        fleetRecovering = false;
      }
    }
    return { recovered: false };
  }

  fleetZeroOrdersSince = null;

  if (runningCount > 0 && totalOo > 0) {
    let detached = 0;
    for (const id of fleet.runningMarketIds()) {
      if (fleet.bot(id).isOrdersDetachedFromPrice()) detached++;
    }
    if (detached > 0 && detached >= runningCount) {
      fleetRecovering = true;
      try {
        log.warn(
          `[Grid/${opts.exchangeLabel}] 空转恢复：${detached} 个 bot 现价脱离挂单区，强制居中重挂`
        );
        for (const id of fleet.runningMarketIds()) {
          await fleet.bot(id).ensureGridNearPrice().catch(() => false);
        }
        clearIdleTimers();
        return { recovered: true, reason: "detached_from_price" };
      } finally {
        fleetRecovering = false;
      }
    }
  }

  fleetZeroOrdersSince = null;
  return { recovered: false };
}

async function reconcileUnmanagedOrders(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  opts: { exchangeLabel?: string; candidateNames?: string[] }
): Promise<number> {
  const runningIds = fleet.runningMarketIds();
  const managed = new Set<string>();
  for (const id of runningIds) {
    const bot = fleet.bot(id);
    if (!bot.running) continue;
    for (const oid of bot.getManagedOrderIds()) managed.add(oid);
  }
  const fn = (
    exchange as GridExchangeAdapter & {
      cancelUnmanagedOrders?: (ids: Set<string>, runningMarketIds: number[], allowedSymbols: string[]) => Promise<number>;
    }
  ).cancelUnmanagedOrders;
  if (!fn) return 0;
  return fn.call(exchange, managed, runningIds, opts.candidateNames ?? []);
}

/** 挂单超出网格容量或同格重复 → 强制以现价重挂收敛 */
export async function convergeOverflowGrids(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  exchangeLabel?: string
): Promise<{ converged: string[] }> {
  const converged: string[] = [];
  for (const id of fleet.runningMarketIds()) {
    const bot = fleet.bot(id);
    if (!bot.running) continue;
    const st = bot.getState();
    const cfg = st.config as { gridCount?: number; symbol?: string; displayName?: string } | null;
    const gridCount = cfg?.gridCount ?? (st.grid as { count?: number } | null)?.count ?? 0;
    const maxOo = gridCount + 2;
    const open = (st.openOrders as number) ?? 0;
    const sym = cfg?.symbol ?? cfg?.displayName ?? String(id);
    const list = (st.openOrdersList as { levelIndex?: number; side?: string }[]) ?? [];
    const keys = new Set<string>();
    let dup = false;
    for (const o of list) {
      if (o.levelIndex == null || o.levelIndex < 0) continue;
      const k = `${o.levelIndex}:${o.side}`;
      if (keys.has(k)) {
        dup = true;
        break;
      }
      keys.add(k);
    }
    const minOo = Math.max(6, Math.ceil(gridCount * 0.35));
    const over = open > maxOo;
    const under = open < minOo;
    const detached = open >= minOo && bot.isOrdersDetachedFromPrice((st.lastPrice as number) ?? 0);
    if (!over && !under && !dup && !detached) continue;
    if (detached) {
      log.warn(`[Grid/${exchangeLabel ?? ""}] ${sym} 现价脱离挂单区，强制居中重挂`);
    } else if (over || dup) {
      log.warn(
        `[Grid/${exchangeLabel ?? ""}] ${sym} 挂单 ${open}（上限 ${maxOo}${dup ? "，同格重复" : ""}），强制收敛重挂`
      );
    } else {
      log.warn(`[Grid/${exchangeLabel ?? ""}] ${sym} 挂单 ${open} 偏少（目标≥${minOo}），补铺不重挂`);
      await bot.replenishIfEmpty().catch((e: Error) => {
        log.warn(`[Grid/${exchangeLabel ?? ""}] ${sym} 补铺失败: ${e.message}`);
      });
      converged.push(sym);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const ok = await bot.recenter((st.lastPrice as number) ?? 0, { force: true }).catch(() => false);
    if (ok) converged.push(sym);
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { converged };
}

/** 链上/API 读到 price≈0 或远离现价的挂单视为无效，需撤单重铺 */
function ordersLookInvalid(open: { price: number }[], lastPrice: number): boolean {
  if (!open.length) return false;
  if (!(lastPrice > 0)) return open.some((o) => !(o.price > 0));
  const sane = open.filter((o) => o.price > lastPrice * 0.15 && o.price < lastPrice * 6);
  return sane.length < Math.max(1, Math.ceil(open.length * 0.4));
}

async function reseedBotIfEmptyOrInvalid(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  marketId: number,
  exchangeLabel?: string
): Promise<void> {
  const bot = fleet.bot(marketId);
  if (!bot.running) return;
  const open = exchange.getOpenOrders(marketId);
  const st = bot.getState();
  const last = (st.lastPrice as number) ?? 0;
  const invalid = ordersLookInvalid(open, last);
  if (open.length === 0 || invalid) {
    if (invalid && open.length > 0) {
      log.warn(`[Grid/${exchangeLabel ?? ""}] ${(st.config as { symbol?: string })?.symbol} 挂单异常(${open.length}笔)，撤单重铺`);
      await exchange.cancelAll(marketId).catch(() => {});
    }
    await bot.replenishIfEmpty().catch((e: Error) => {
      log.warn(`[Grid/${exchangeLabel ?? ""}] ${(st.config as { symbol?: string })?.symbol} 补铺失败: ${e.message}`);
    });
  }
}

async function isBotTrending(exchange: GridExchangeAdapter, marketId: number): Promise<boolean> {
  const candles = await exchange.getCandles(marketId, 900, 96).catch(() => []);
  if (candles.length < 30) return false;
  const t = analyzeTrend(candles);
  return t.trend !== "range" && t.strength > 0.45;
}

async function replenishEmptyGrids(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  exchangeLabel?: string
): Promise<void> {
  for (const id of fleet.runningMarketIds()) {
    const bot = fleet.bot(id);
    if (!bot.running || bot.outOfRange) continue;
    if (await isBotTrending(exchange, id)) {
      await bot.ensureGridNearPrice().catch(() => false);
      continue;
    }
    await reseedBotIfEmptyOrInvalid(fleet, exchange, id, exchangeLabel);
  }
}

export function startFleetMaintainer(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  opts: { slotCount: number; candidateNames: string[]; preferSymbols?: string[]; exchangeLabel?: string; profile?: FleetVenueProfile },
  intervalMs?: number
) {
  const tickMs = intervalMs ?? opts.profile?.defaults.ROTATION_CHECK_MS ?? FLEET_DEFAULTS.ROTATION_CHECK_MS;
  const tick = () =>
    maintainFleet(fleet, exchange, opts).catch((e) => {
      recordMaintainError(`${opts.exchangeLabel}: ${(e as Error)?.message ?? e}`);
    });
  setTimeout(tick, 90_000);
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  return timer;
}

/** 每 3 分钟检查空转（主维护器默认 45 分钟一轮，单靠它无法及时恢复） */
export function startFleetIdleWatchdog(
  fleet: GridFleet,
  exchange: GridExchangeAdapter,
  opts: { slotCount: number; candidateNames: string[]; preferSymbols?: string[]; exchangeLabel?: string; profile?: FleetVenueProfile },
  intervalMs = 3 * 60_000
) {
  const tick = () =>
    recoverIdleFleet(fleet, exchange, opts).catch((e) => {
      recordMaintainError(`watchdog ${opts.exchangeLabel}: ${(e as Error)?.message ?? e}`);
    });
  setTimeout(tick, 60_000);
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
