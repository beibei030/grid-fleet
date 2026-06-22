import { config } from "../config.js";
import type { GridFleetState } from "../grid/gridFleet.js";

export interface DecibelGridState {
  ok: boolean;
  error?: string;
  unreachable?: boolean;
  state?: GridFleetState | null;
}

let cachedRemoteState: GridFleetState | null = null;

export function getCachedDecGridRemoteState(): GridFleetState | null {
  return cachedRemoteState;
}

function baseUrl(): string {
  return config.decGridFleet.url.replace(/\/$/, "");
}

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (json) headers["Content-Type"] = "application/json";
  const token = config.decGridFleet.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** 仅 localhost 读取 decibel-grid :8083 状态 */
export async function fetchDecibelGridState(): Promise<DecibelGridState> {
  if (!config.decGrid.standalone) {
    return { ok: false, error: "Dec 网格未配置为独立进程", unreachable: false };
  }
  const url = `${baseUrl()}/api/state`;
  try {
    const r = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      cachedRemoteState = null;
      return { ok: false, error: `Decibel grid HTTP ${r.status}`, unreachable: r.status >= 500 };
    }
    const state = (await r.json()) as GridFleetState;
    cachedRemoteState = state;
    return { ok: true, state };
  } catch (e: any) {
    cachedRemoteState = null;
    return {
      ok: false,
      error: e?.message ?? "Decibel grid 不可达",
      unreachable: true,
    };
  }
}

async function postJson<T = Record<string, unknown>>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  const r = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export async function proxyDecibelFleetRestart(closeFirst = true): Promise<{ ok: boolean; error?: string; state?: GridFleetState }> {
  try {
    const data = await postJson<{ ok?: boolean; state?: GridFleetState; error?: string }>("/api/fleet/restart", { closeFirst });
    if (data.state) cachedRemoteState = data.state;
    return { ok: true, state: data.state };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function proxyDecibelFleetStart(): Promise<{ ok: boolean; error?: string; state?: GridFleetState }> {
  try {
    const data = await postJson<{ ok?: boolean; state?: GridFleetState; error?: string }>("/api/fleet/start", {});
    if (data.state) cachedRemoteState = data.state;
    return { ok: true, state: data.state };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function proxyDecibelFleetStop(closePosition = true): Promise<{ ok: boolean; error?: string }> {
  try {
    await postJson("/api/stop", { closePosition }, 15_000);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function proxyDecibelResetSession(): Promise<{ ok: boolean; error?: string; baselineEquity?: number }> {
  const token = config.decGridFleet.token;
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  try {
    const r = await fetch(`${baseUrl()}/api/session/reset${qs}`, {
      method: "POST",
      headers: authHeaders(true),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return { ok: false, error: `Decibel grid HTTP ${r.status}` };
    const body = (await r.json()) as { ok?: boolean; baselineEquity?: number; error?: string };
    if (body.error) return { ok: false, error: body.error };
    return { ok: true, baselineEquity: body.baselineEquity };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "8083 不可达" };
  }
}

export async function proxyDecibelGridGet<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl()}${path}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}
