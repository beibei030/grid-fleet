#!/usr/bin/env node
/**
 * 三所网格全自动外层巡检
 * - 需 EXTENDED_GRID_URL / RISEX_GRID_URL / DEC_GRID_URL
 * - snapshot fleetHealth + recommendAction
 * - GRID_HEALTH_AUTO_FIX=1 时按 action 触发修复（10min 冷却，busy 跳过）
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const LOG_DIR = process.env.GRID_LOG_DIR || path.join(__dirname, '..', 'logs');
const COOLDOWN_FILE = path.join(LOG_DIR, 'grid-health-cooldown.json');
const COOLDOWN_MS = Number(process.env.GRID_HEALTH_COOLDOWN_MS || 10 * 60_000);
const token = (process.env.GRID_AUTH_TOKEN || '').trim();
const autoFix = process.env.GRID_HEALTH_AUTO_FIX === '1';

const GRID_URL = {
  extended: process.env.EXTENDED_GRID_URL || '',
  risex: process.env.RISEX_GRID_URL || '',
  decibel: process.env.DEC_GRID_URL || '',
};

const VENUES = [
  { key: 'extended', label: 'Extended', slots: 3, gridCount: 24 },
  { key: 'risex', label: 'RISEx', slots: 3, gridCount: 18 },
  { key: 'decibel', label: 'Decibel', slots: 3, gridCount: 22 },
];

const ACTIONS = {
  extended: { resume: '/api/fleet/resume', converge: '/api/fleet/converge', seed: '/api/fleet/seed', restart: '/api/fleet/restart', body: { closeFirst: false } },
  risex: { resume: '/api/fleet/resume', converge: '/api/fleet/converge', seed: '/api/fleet/seed', restart: '/api/fleet/restart', body: { closeFirst: false } },
  decibel: { resume: '/api/fleet/resume', converge: '/api/fleet/converge', seed: '/api/fleet/restart', restart: '/api/fleet/restart', body: { closeFirst: false } },
};

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(`${LOG_DIR}\\grid-health.log`, msg + '\n');
  } catch { /* ignore */ }
}

function loadCooldown() {
  try {
    return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCooldown(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data, null, 2));
  } catch { /* ignore */ }
}

function canFix(key, action) {
  const data = loadCooldown();
  const last = data[`${key}:${action}`] || 0;
  return Date.now() - last >= COOLDOWN_MS;
}

function markFix(key, action) {
  const data = loadCooldown();
  data[`${key}:${action}`] = Date.now();
  saveCooldown(data);
}

function hostPort(key) {
  const raw = GRID_URL[key];
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      hostname: u.hostname || '127.0.0.1',
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    };
  } catch {
    return null;
  }
}

function httpGet(key, path, timeoutMs = 15000) {
  const hp = hostPort(key);
  if (!hp) return Promise.resolve({ ok: false, error: `missing ${key} grid URL` });
  return new Promise((resolve) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const req = http.get({ hostname: hp.hostname, port: hp.port, path, headers, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(b) });
        } catch {
          resolve({ ok: false, status: res.statusCode, raw: b.slice(0, 120) });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

function httpPost(key, path, body, timeoutMs = 120000) {
  const hp = hostPort(key);
  if (!hp) return Promise.resolve({ ok: false, error: `missing ${key} grid URL` });
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const req = http.request(
      { hostname: hp.hostname, port: hp.port, path, method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(b) });
          } catch {
            resolve({ ok: false, status: res.statusCode, raw: b.slice(0, 200) });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

async function fetchVenueState(v) {
  let r = await httpGet(v.key, '/api/snapshot', 18000);
  if (!r.ok) r = await httpGet(v.key, '/api/state', 25000);
  return r;
}

function fallbackHealth(state, v) {
  const openOrders = state?.openOrders ?? 0;
  const botCount = state?.botCount ?? 0;
  const running = !!state?.running;
  const paused = !!(state?.fleetMeta?.paused ?? state?.paused);
  let expected = v.slots * Math.max(6, Math.floor(v.gridCount * 0.85));
  if (state?.bots?.length) {
    expected = 0;
    for (const b of state.bots) {
      if (!b.running) continue;
      const gc = b.config?.gridCount ?? b.grid?.count ?? v.gridCount;
      expected += Math.max(6, Math.floor(gc * 0.85));
    }
    if (expected === 0) expected = v.slots * Math.max(6, Math.floor(v.gridCount * 0.85));
  }
  const ratio = expected > 0 ? Math.min(1, openOrders / expected) : 0;
  let recommendAction = 'wait';
  if (paused) recommendAction = 'resume';
  else if (!running || botCount < v.slots) recommendAction = 'seed';
  else if (ratio < 0.5) recommendAction = 'seed';
  else if (ratio < 0.85) recommendAction = 'converge';
  else if (openOrders === 0 && botCount > 0) recommendAction = 'restart';
  const healthy = !paused && running && botCount >= v.slots && ratio >= 0.85 && openOrders > 0;
  return {
    healthy,
    phase: ratio < 0.85 && running ? 'seeding' : running ? 'maintaining' : 'idle',
    openOrdersRatio: Math.round(ratio * 1000) / 1000,
    expectedOrders: expected,
    recommendAction,
    restarting: !!(state?.fleetMeta?.restarting),
    recovering: !!(state?.fleetMeta?.recovering),
  };
}

function ensureProcess(v) {
  const key = v.key || null;
  if (!key) {
    const overviewUrl = process.env.OVERVIEW_URL || '';
    if (!overviewUrl) return Promise.resolve({ up: false });
    try {
      const u = new URL(overviewUrl);
      const hp = { hostname: u.hostname, port: Number(u.port) || 80 };
      return new Promise((resolve) => {
        const req = http.get({ hostname: hp.hostname, port: hp.port, path: '/api/health', timeout: 8000 }, (res) => {
          resolve({ up: res.statusCode === 200 });
        });
        req.on('error', () => resolve({ up: false }));
      });
    } catch {
      return Promise.resolve({ up: false });
    }
  }
  return httpGet(key, '/api/health', 8000).then((r) => {
    if (r.ok) return { up: true };
    log(`[process] ${v.label} down — 请手动启动 grid 进程`);
    return { up: false };
  });
}

function pickFixPath(cfg, action) {
  if (action === 'resume') return { path: cfg.resume, body: undefined };
  if (action === 'seed') return { path: cfg.seed, body: cfg.body };
  if (action === 'restart') return { path: cfg.restart, body: { closeFirst: false } };
  return { path: cfg.converge, body: cfg.body };
}

(async () => {
  let exitCode = 0;
  await ensureProcess({ label: 'Overview' });

  for (const v of VENUES) {
    const proc = await ensureProcess(v);
    const r = await fetchVenueState(v);
    if (!r.ok) {
      log(`[health] ${v.label} unreachable (${r.error || r.status}) proc=${proc.up ? 'up' : 'restarted'}`);
      exitCode = 1;
      continue;
    }
    const state = r.data || {};
    const fh = state.fleetHealth || state.fleetMeta?.fleetHealth || fallbackHealth(state, v);
    const act = fh.recommendAction || 'wait';
    log(
      `[health] ${v.label} healthy=${fh.healthy} phase=${fh.phase} action=${act} orders=${state.openOrders ?? 0}/${fh.expectedOrders ?? '?'} ratio=${fh.openOrdersRatio ?? '?'}`
    );

    if (!autoFix) continue;
    if (act === 'wait' || fh.healthy) continue;
    if (fh.restarting || fh.recovering || fh.phase === 'busy') {
      log(`[health] ${v.label} skip fix (busy)`);
      continue;
    }
    if (!canFix(v.key, act)) {
      log(`[health] ${v.label} skip fix (cooldown ${act})`);
      continue;
    }

    const cfg = ACTIONS[v.key];
    if (!cfg) continue;
    const { path, body } = pickFixPath(cfg, act);
    log(`[health] auto-fix ${v.key} POST ${path}`);
    const fix = await httpPost(v.key, path, body);
    markFix(v.key, act);
    const oo = fix.data?.state?.openOrders ?? fix.data?.openOrders ?? fix.error ?? fix.raw ?? '';
    log(`[health] fix result ok=${fix.ok} orders=${oo}`);
    if (!fix.ok) exitCode = 1;
  }

  process.exit(exitCode);
})();
