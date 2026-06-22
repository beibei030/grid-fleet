/**
 * 空转分级恢复：5min soft（maintain/converge）→ 10min hard（restart closeFirst:false）
 */
import { ACTIVE_SLOTS, restartFleet, isFleetRestarting, getFleetLockMeta } from './fleet-plan.js';
import { maintainFleet } from './fleet-maintain.js';
import { recoverFleetSeeding } from './fleet-seed.js';
import { isFleetPaused } from './fleet-control.js';

let fleetUnderCapacitySince = null;
let fleetUnderCapacitySoftTried = false;
let fleetZeroOrdersSince = null;
let fleetRecovering = false;
let lastMaintainError = null;
let maintainErrorTimestamps = [];

export function recordMaintainError(msg) {
  lastMaintainError = msg;
  const now = Date.now();
  maintainErrorTimestamps.push(now);
  maintainErrorTimestamps = maintainErrorTimestamps.filter((t) => now - t < 3600_000);
  console.warn(`[Fleet] maintain: ${msg}`);
}

export function getMaintainDiagnostics() {
  const now = Date.now();
  maintainErrorTimestamps = maintainErrorTimestamps.filter((t) => now - t < 3600_000);
  return { lastError: lastMaintainError, errorsLastHour: maintainErrorTimestamps.length };
}

export function isFleetRecovering() {
  return fleetRecovering;
}

function clearIdleTimers() {
  fleetUnderCapacitySince = null;
  fleetUnderCapacitySoftTried = false;
  fleetZeroOrdersSince = null;
}

function totalOpenOrders(fleet) {
  let n = 0;
  for (const b of fleet.getState().bots ?? []) {
    if (b.running) n += b.openOrders || 0;
  }
  return n;
}

export async function recoverIdleFleet(
  fleet,
  exchange,
  opts = {},
  thresholds = { underCapacitySoftMs: 5 * 60_000, underCapacityHardMs: 10 * 60_000, zeroOrdersMs: 10 * 60_000 }
) {
  if (isFleetPaused() || fleetRecovering) {
    clearIdleTimers();
    return { recovered: false };
  }
  if (isFleetRestarting()) {
    return { recovered: false, reason: 'busy_lock' };
  }

  const slotCount = opts.slotCount ?? ACTIVE_SLOTS;
  const runningCount = [...fleet.bots.values()].filter((b) => b.running).length;
  const totalOo = totalOpenOrders(fleet);
  const now = Date.now();

  if (runningCount >= slotCount && totalOo > 0) {
    clearIdleTimers();
    return { recovered: false, reason: 'ok' };
  }

  if (runningCount < slotCount) {
    if (!fleetUnderCapacitySince) {
      fleetUnderCapacitySince = now;
      fleetUnderCapacitySoftTried = false;
    } else if (!fleetUnderCapacitySoftTried && now - fleetUnderCapacitySince >= thresholds.underCapacitySoftMs) {
      fleetRecovering = true;
      fleetUnderCapacitySoftTried = true;
      try {
        console.warn(`[Fleet] 槽位未满 ${runningCount}/${slotCount} → soft recover`);
        await recoverFleetSeeding(fleet, exchange);
        await maintainFleet(fleet, exchange);
        if (fleet.getState().botCount >= slotCount) clearIdleTimers();
        return { recovered: true, reason: 'under_capacity_soft' };
      } catch (e) {
        recordMaintainError(`idleSoft: ${e.message}`);
      } finally {
        fleetRecovering = false;
      }
    } else if (now - fleetUnderCapacitySince >= thresholds.underCapacityHardMs) {
      fleetRecovering = true;
      try {
        console.error(`[Fleet] 空转 ${Math.round((now - fleetUnderCapacitySince) / 60000)}min → hard restart`);
        await restartFleet(fleet, exchange, { closeFirst: false });
        clearIdleTimers();
        return { recovered: true, reason: 'under_capacity' };
      } catch (e) {
        recordMaintainError(`idleHard: ${e.message}`);
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
        console.error(`[Fleet] ${runningCount} bot 在跑但 0 挂单 → hard restart`);
        await restartFleet(fleet, exchange, { closeFirst: false });
        clearIdleTimers();
        return { recovered: true, reason: 'zero_orders' };
      } catch (e) {
        recordMaintainError(`zeroOrders: ${e.message}`);
      } finally {
        fleetRecovering = false;
      }
    }
    return { recovered: false };
  }

  fleetZeroOrdersSince = null;
  return { recovered: false };
}

export function startFleetIdleWatchdog(fleet, exchange, opts = {}, intervalMs = 3 * 60_000) {
  const tick = () =>
    recoverIdleFleet(fleet, exchange, opts).catch((e) => {
      recordMaintainError(`watchdog: ${e.message}`);
    });
  setTimeout(tick, 60_000);
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
