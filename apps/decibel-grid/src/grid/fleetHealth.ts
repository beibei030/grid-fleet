import { getFleetLockMeta, getMaintainDiagnostics } from "./fleetRestart.js";
import { isFleetPaused } from "./fleetControl.js";
import type { GridFleetState } from "./gridFleet.js";

export type FleetHealthPhase = "seeding" | "maintaining" | "recovering" | "paused" | "busy" | "idle";
export type FleetRecommendAction = "seed" | "converge" | "resume" | "wait" | "restart";

export interface FleetHealth {
  healthy: boolean;
  phase: FleetHealthPhase;
  openOrdersRatio: number;
  expectedOrders: number;
  lastError: string | null;
  maintainErrorsLastHour: number;
  recommendAction: FleetRecommendAction;
  restarting: boolean;
  restartingSince: number | null;
  recovering: boolean;
}

function expectedOpenOrders(state: GridFleetState | null, activeSlots: number): number {
  if (!state?.bots?.length) return activeSlots * 18;
  let total = 0;
  for (const b of state.bots) {
    if (!b.running) continue;
    const cfg = b.config as { gridCount?: number } | null;
    const gc = cfg?.gridCount ?? (b.grid as { count?: number } | null)?.count ?? 18;
    total += Math.max(6, Math.floor(gc * 0.85));
  }
  if (total > 0) return total;
  return activeSlots * 18;
}

export function computeFleetHealth(
  state: GridFleetState | null,
  activeSlots: number
): FleetHealth {
  const lock = getFleetLockMeta();
  const diag = getMaintainDiagnostics();
  const paused = isFleetPaused() || !!(state?.fleetMeta as { paused?: boolean })?.paused;
  const openOrders = state?.openOrders ?? 0;
  const expected = expectedOpenOrders(state, activeSlots);
  const ratio = expected > 0 ? Math.min(1, openOrders / expected) : 0;
  const botCount = state?.botCount ?? 0;
  const running = !!state?.running;

  let phase: FleetHealthPhase = "idle";
  if (paused) phase = "paused";
  else if (lock.restarting) phase = "busy";
  else if (lock.recovering) phase = "recovering";
  else if (running && ratio < 0.85) phase = "seeding";
  else if (running) phase = "maintaining";

  let recommendAction: FleetRecommendAction = "wait";
  if (paused) recommendAction = "resume";
  else if (lock.restarting) recommendAction = "wait";
  else if (!running || botCount < activeSlots) recommendAction = "seed";
  else if (ratio < 0.5) recommendAction = "seed";
  else if (ratio < 0.85 || state?.outOfRange) recommendAction = "converge";
  else if (openOrders === 0 && botCount > 0) recommendAction = "restart";

  const healthy =
    !paused &&
    !lock.restarting &&
    running &&
    botCount >= activeSlots &&
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
    restarting: lock.restarting,
    restartingSince: lock.restartingSince || null,
    recovering: lock.recovering,
  };
}

export function attachFleetHealth(
  state: GridFleetState | null,
  activeSlots: number
): (GridFleetState & { fleetHealth: FleetHealth }) | null {
  if (!state) return state;
  const health = computeFleetHealth(state, activeSlots);
  const fleetMeta = {
    ...(state.fleetMeta as Record<string, unknown>),
    restarting: health.restarting,
    restartingSince: health.restartingSince,
    recovering: health.recovering,
    fleetHealth: health,
  };
  return { ...state, fleetMeta, fleetHealth: health } as GridFleetState & { fleetHealth: FleetHealth };
}
