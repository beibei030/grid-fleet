/**
 * RISEx 空转分级恢复（对齐 Dec idle watchdog）
 */
import { ACTIVE_SLOTS, restartFleet, isFleetRestarting, getFleetLockMeta } from './fleet-plan.js';
import { maintainFleet } from './fleet-maintain.js';
import { recoverFleetSeeding, isFleetRecovering as isSeedRecovering } from './fleet-seed.js';
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
  return fleetRecovering || isSeedRecovering();
}

function clearIdleTimers() {
  fleetUnderCapacitySince = null;
  fleetUnderCapacitySoftTried = false;
  fleetZeroOrdersSince = null;
}

function runningCount(fleet) {
  return [...fleet.bots.values()].filter((b) => b.running).length;
}

function totalOpenOrders(fleet) {
  return fleet.getState().openOrders ?? 0;
}

export async function recoverIdleFleet(
  fleet,
  exchange,
  opts = {},
  thresholds = { underCapacitySoftMs: 5 * 60_000, underCapacityHardMs: 12 * 60_000, zeroOrdersMs: 12 * 60_000 }
) {
  if (isFleetPaused() || fleetRecovering || isSeedRecovering()) {
    clearIdleTimers();
    return { recovered: false };
  }
  if (isFleetRestarting()) return { recovered: false, reason: 'busy_lock' };

  const slotCount = opts.slotCount ?? ACTIVE_SLOTS;
  const running = runningCount(fleet);
  const totalOo = totalOpenOrders(fleet);
  const now = Date.now();

  if (running >= slotCount && totalOo > 0) {
    clearIdleTimers();
    return { recovered: false, reason: 'ok' };
  }

  if (running < slotCount) {
    if (!fleetUnderCapacitySince) {
      fleetUnderCapacitySince = now;
      fleetUnderCapacitySoftTried = false;
    } else if (!fleetUnderCapacitySoftTried && now - fleetUnderCapacitySince >= thresholds.underCapacitySoftMs) {
      fleetRecovering = true;
      fleetUnderCapacitySoftTried = true;
      try {
        console.warn(`[Fleet] 槽位未满 ${running}/${slotCount} → soft seed`);
        await recoverFleetSeeding(fleet, exchange);
        await maintainFleet(fleet, exchange);
        if (runningCount(fleet) >= slotCount) clearIdleTimers();
        return { recovered: true, reason: 'under_capacity_soft' };
      } catch (e) {
        recordMaintainError(`idleSoft: ${e.message}`);
      } finally {
        fleetRecovering = false;
      }
    } else if (now - fleetUnderCapacitySince >= thresholds.underCapacityHardMs) {
      fleetRecovering = true;
      try {
        console.error(`[Fleet] RISEx 空转 ${Math.round((now - fleetUnderCapacitySince) / 60000)}min → staged restart`);
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

  if (running > 0 && totalOo === 0) {
    if (!fleetZeroOrdersSince) fleetZeroOrdersSince = now;
    else if (now - fleetZeroOrdersSince >= thresholds.zeroOrdersMs) {
      fleetRecovering = true;
      try {
        console.error(`[Fleet] ${running} bot 在跑但 0 挂单 → recover seed`);
        await recoverFleetSeeding(fleet, exchange);
        if (totalOpenOrders(fleet) === 0) {
          await restartFleet(fleet, exchange, { closeFirst: false });
        }
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
  setTimeout(tick, 90_000);
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

export { getFleetLockMeta };
