/** Fleet health for Extended snapshot (RISEx-style bounded seed/converge rules). */
import { isFleetPaused } from './fleet-control.js';
import { getFleetLockMeta, isFleetRestarting, ACTIVE_SLOTS } from './fleet-plan.js';
import { isFleetRecovering, getMaintainDiagnostics } from './fleet-idle-recover.js';

import { FLEET_DEFAULTS } from './fleet-plan.js';

const DEFAULT_GRID = FLEET_DEFAULTS.UNIFIED_GRID_COUNT;

function expectedOpenOrders(state) {
  if (!state?.bots?.length) return ACTIVE_SLOTS * Math.max(6, Math.floor(DEFAULT_GRID * 0.85));
  let total = 0;
  for (const b of state.bots) {
    if (!b.running) continue;
    const gc = b.config?.gridCount ?? b.grid?.count ?? DEFAULT_GRID;
    total += Math.max(6, Math.floor(gc * 0.85));
  }
  return total > 0 ? total : ACTIVE_SLOTS * Math.max(6, Math.floor(DEFAULT_GRID * 0.85));
}

function hasOverfilledBot(state) {
  return (state?.bots || []).some((b) => {
    if (!b.running) return false;
    const gc = b.config?.gridCount ?? b.grid?.count ?? DEFAULT_GRID;
    const oo = b.openOrders ?? b.botOpenOrders ?? 0;
    return oo > gc + 2;
  });
}

export function computeFleetHealth(state) {
  const lock = getFleetLockMeta();
  const diag = getMaintainDiagnostics();
  const paused = isFleetPaused();
  const openOrders = state?.openOrders ?? 0;
  const expected = expectedOpenOrders(state);
  const ratio = expected > 0 ? Math.min(1, openOrders / expected) : 0;
  const botCount = state?.botCount ?? 0;
  const running = !!state?.running;
  const recovering = isFleetRecovering();
  const overfilled = hasOverfilledBot(state);

  let phase = 'idle';
  if (paused) phase = 'paused';
  else if (lock.restarting) phase = 'busy';
  else if (recovering) phase = 'recovering';
  else if (running && ratio < 0.85) phase = 'seeding';
  else if (running) phase = 'maintaining';

  let recommendAction = 'wait';
  if (paused) recommendAction = 'resume';
  else if (lock.restarting || recovering) recommendAction = 'wait';
  else if (!running || botCount < ACTIVE_SLOTS) recommendAction = 'seed';
  else if (ratio < 0.85) recommendAction = 'seed';
  else if (overfilled) recommendAction = 'converge';
  else if (openOrders === 0 && botCount > 0) recommendAction = 'restart';

  const healthy =
    !paused &&
    !lock.restarting &&
    !recovering &&
    running &&
    botCount >= ACTIVE_SLOTS &&
    ratio >= 0.85 &&
    openOrders > 0;

  return {
    healthy,
    phase,
    openOrdersRatio: Math.round(ratio * 1000) / 1000,
    expectedOrders: expected,
    lastError: diag.lastError,
    maintainErrorsLastHour: diag.errorsLastHour,
    recommendAction,
    overfilled,
    restarting: lock.restarting,
    restartingSince: lock.restartingSince || null,
    recovering,
  };
}

export function attachFleetHealth(state) {
  if (!state) return state;
  const health = computeFleetHealth(state);
  return {
    ...state,
    fleetHealth: health,
    fleetMeta: {
      ...(state.fleetMeta || {}),
      fleetHealth: health,
      restarting: health.restarting,
      restartingSince: health.restartingSince,
      recovering: health.recovering,
    },
  };
}