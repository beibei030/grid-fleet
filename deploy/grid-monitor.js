#!/usr/bin/env node
/**
 * 三所网格轮询监控
 * - 需 EXTENDED_GRID_URL / RISEX_GRID_URL / DEC_GRID_URL（与各所本机地址一致）
 * - 扫描 snapshot 健康度 + 近期 alerts
 * - GRID_MONITOR_AUTO_FIX=1 时触发轻量修复 API
 * - 连续 CLEAN_STREAK_TARGET 次无问题 → 退出码 2（停止轮询）
 * 状态: ./logs/grid-monitor-state.json（可用 GRID_LOG_DIR 覆盖）
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const LOG_DIR = process.env.GRID_LOG_DIR || path.join(__dirname, '..', 'logs');
const STATE_FILE = path.join(LOG_DIR, 'grid-monitor-state.json');
const MON_LOG = path.join(LOG_DIR, 'grid-monitor.log');
const COOLDOWN_FILE = path.join(LOG_DIR, 'grid-health-cooldown.json');
const CLEAN_TARGET = Number(process.env.CLEAN_STREAK_TARGET || 3);
const COOLDOWN_MS = Number(process.env.GRID_HEALTH_COOLDOWN_MS || 10 * 60_000);
const STALE_MS = Number(process.env.GRID_MONITOR_STALE_MS || 120_000);
const autoFix = process.env.GRID_MONITOR_AUTO_FIX !== '0';
const token = (process.env.GRID_AUTH_TOKEN || '').trim();

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

const ALERT_BAD = [
  { re: /reduceOnly is not defined/i, code: 'EXT_REDUCEONLY_BUG' },
  { re: /1137.*reduce-only|Position is missing for reduce-only/i, code: 'REDUCEONLY_NO_POS' },
  { re: /PlaceOrderWithPermitV2 reverted|ReduceOnlyOrderNotReducing/i, code: 'RISE_CHAIN_REVERT' },
  { re: /重挂熔断/i, code: 'RECENTER_FUSE' },
  { re: /maintainErrorsLastHour/i, code: 'MAINTAIN_ERR' },
];

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(MON_LOG, msg + '\n');
  } catch { /* ignore */ }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { cleanStreak: 0, stopped: false, history: [] }; }
}

function saveState(st) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  } catch { /* ignore */ }
}

function loadCooldown() {
  try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8')); } catch { return {}; }
}

function markFix(key, action) {
  const data = loadCooldown();
  data[`${key}:${action}`] = Date.now();
  try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
}

function canFix(key, action) {
  const last = loadCooldown()[`${key}:${action}`] || 0;
  return Date.now() - last >= COOLDOWN_MS;
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

function httpGet(key, path, timeoutMs = 18000) {
  const hp = hostPort(key);
  if (!hp) return Promise.resolve({ ok: false, error: `missing ${key} grid URL` });
  return new Promise((resolve) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const req = http.get({ hostname: hp.hostname, port: hp.port, path, headers, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ ok: false, status: res.statusCode, raw: b.slice(0, 200) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function httpPost(key, path, body, timeoutMs = 120000) {
  const hp = hostPort(key);
  if (!hp) return Promise.resolve({ ok: false, error: `missing ${key} grid URL` });
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    const req = http.request({ hostname: hp.hostname, port: hp.port, path, method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ ok: false, status: res.statusCode, raw: b.slice(0, 200) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
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
      expected += Math.max(6, Math.floor((b.config?.gridCount ?? b.grid?.count ?? v.gridCount) * 0.85));
    }
    if (!expected) expected = v.slots * Math.max(6, Math.floor(v.gridCount * 0.85));
  }
  const ratio = expected > 0 ? Math.min(1, openOrders / expected) : 0;
  let recommendAction = 'wait';
  if (paused) recommendAction = 'resume';
  else if (!running || botCount < v.slots) recommendAction = 'seed';
  else if (ratio < 0.5) recommendAction = 'seed';
  else if (ratio < 0.85) recommendAction = 'converge';
  else if (openOrders === 0 && botCount > 0) recommendAction = 'restart';
  return {
    healthy: !paused && running && botCount >= v.slots && ratio >= 0.85 && openOrders > 0,
    phase: ratio < 0.85 && running ? 'seeding' : running ? 'maintaining' : 'idle',
    openOrdersRatio: Math.round(ratio * 1000) / 1000,
    expectedOrders: expected,
    recommendAction,
    restarting: !!(state?.fleetMeta?.restarting ?? state?.fleetHealth?.restarting),
    recovering: !!(state?.fleetMeta?.recovering ?? state?.fleetHealth?.recovering),
    maintainErrorsLastHour: state?.fleetHealth?.maintainErrorsLastHour ?? 0,
    lastError: state?.fleetHealth?.lastError ?? null,
  };
}

function scanAlerts(alerts, venue, cutoffMs) {
  const issues = [];
  const list = (alerts || []).slice(0, 30);
  let failCount = 0;
  const now = Date.now();
  for (const a of list) {
    if (a.t && a.t < cutoffMs) continue;
    const msg = a.message || '';
    if (/下单失败/i.test(msg)) failCount++;
    for (const p of ALERT_BAD) {
      if (p.re.test(msg)) issues.push({ venue, code: p.code, message: msg.slice(0, 160), symbol: a.symbol });
    }
  }
  if (failCount >= 3) {
    issues.push({ venue, code: 'ORDER_FAIL_BURST', message: `近 10 分钟内 ${failCount} 次下单失败` });
  }
  return issues;
}

function scanStructure(v, state, fh) {
  const issues = [];
  const key = v.key;
  if (!state.running && (state.accountOpenOrders > 0 || state.openOrders > 0)) {
    const ph = state.fleetHealth?.phase;
    if (ph !== 'recovering' && ph !== 'busy' && ph !== 'seeding') {
      issues.push({ venue: key, code: 'PROC_IDLE_WITH_ORDERS', message: `进程未 running 但链上/本地仍有单 phase=${ph}` });
    }
  }
  if (state.fleetMeta?.paused || state.paused) {
    issues.push({ venue: key, code: 'PAUSED', message: '舰队已 pause' });
  }
  if ((state.botCount ?? 0) < v.slots && !fh.healthy && fh.phase !== 'busy' && fh.phase !== 'seeding' && !fh.recovering) {
    issues.push({ venue: key, code: 'UNDER_SLOTS', message: `bot ${state.botCount}/${v.slots} phase=${fh.phase}` });
  }
  if (!fh.healthy && fh.recommendAction && fh.recommendAction !== 'wait') {
    issues.push({ venue: key, code: 'UNHEALTHY', message: `healthy=false action=${fh.recommendAction} ratio=${fh.openOrdersRatio}` });
  }
  if ((fh.maintainErrorsLastHour ?? 0) > 0) {
    issues.push({ venue: key, code: 'MAINTAIN_ERR', message: `maintainErrorsLastHour=${fh.maintainErrorsLastHour}` });
  }
  if (fh.lastError) {
    issues.push({ venue: key, code: 'LAST_ERROR', message: String(fh.lastError).slice(0, 120) });
  }
  const since = fh.restartingSince || state.fleetHealth?.restartingSince;
  if (fh.restarting && since && Date.now() - since > 8 * 60_000) {
    issues.push({ venue: key, code: 'RESTART_STUCK', message: 'restarting 锁超过 8 分钟' });
  }
  return issues;
}

async function ensureProcess(v) {
  const r = await httpGet(v.key, '/api/health', 8000);
  if (r.ok) return { up: true };
  log(`[monitor] ${v.label} :${v.port} down — 请手动启动对应 grid 进程`);
  return { up: false, issue: { venue: v.key, code: 'PROC_DOWN', message: '进程不可达' } };
}

function pickFixPath(cfg, action) {
  if (action === 'resume') return { path: cfg.resume, body: undefined };
  if (action === 'seed') return { path: cfg.seed, body: cfg.body };
  if (action === 'restart') return { path: cfg.restart, body: { closeFirst: false } };
  return { path: cfg.converge, body: cfg.body };
}

async function fetchVenueLiveState(v) {
  const refreshed = await httpPost(v.key, '/api/exchange/refresh', {}, 90000);
  if (refreshed.ok && refreshed.data?.state) {
    return {
      snap: refreshed.data.state,
      refresh: refreshed.data.refresh || null,
      source: 'exchange-refresh',
    };
  }
  let r = await httpGet(v.key, '/api/state', 35000);
  if (!r.ok) r = await httpGet(v.key, '/api/snapshot', 20000);
  return { snap: r.ok ? r.data : {}, refresh: null, source: r.ok ? (r.data?.livePositions ? 'state' : 'snapshot') : 'fail' };
}

function scanExchangeFreshness(v, refresh, source) {
  const issues = [];
  if (source === 'fail') {
    issues.push({ venue: v.key, code: 'EXCHANGE_UNREACHABLE', message: '无法 refresh/state/snapshot' });
    return issues;
  }
  if (source !== 'exchange-refresh') {
    issues.push({ venue: v.key, code: 'REFRESH_FALLBACK', message: `未走交易所 refresh，来源=${source}` });
    return issues;
  }
  const now = Date.now();
  if (!refresh?.ordersAt || now - refresh.ordersAt > STALE_MS) {
    issues.push({ venue: v.key, code: 'STALE_ORDERS', message: `挂单数据过旧 ordersAt=${refresh?.ordersAt || 0}` });
  }
  if (!refresh?.positionsAt || now - refresh.positionsAt > STALE_MS) {
    issues.push({ venue: v.key, code: 'STALE_POSITIONS', message: `持仓数据过旧 positionsAt=${refresh?.positionsAt || 0}` });
  }
  return issues;
}

function scanHeavyInventory(v, snap) {
  const issues = [];
  const rows = snap.livePositions || [];
  for (const p of rows) {
    if (!p.inFleet) continue;
    const bot = (snap.bots || []).find((b) => b.running && (b.config?.displayName === p.market || b.config?.symbol === p.market));
    const sz = bot?.config?.sizeBase ?? 0;
    if (!(sz > 0)) continue;
    const abs = Math.abs(p.sizeBase ?? p.size ?? 0);
    const ratio = abs / (sz * 4);
    if (ratio >= 1.5) {
      issues.push({
        venue: v.key,
        code: 'HEAVY_INVENTORY',
        message: `${p.market} ${p.side} ${abs} = ${ratio.toFixed(1)}×4格上限 (notional ~$${Math.round(p.valueUsd || 0)})`,
      });
    }
  }
  return issues;
}

async function tryAutoFix(v, fh) {
  const act = fh.recommendAction;
  if (!autoFix || !act || act === 'wait' || fh.healthy) return null;
  if (fh.restarting || fh.recovering || fh.phase === 'busy') return null;
  if (!canFix(v.key, act)) return null;
  const cfg = ACTIONS[v.key];
  if (!cfg) return null;
  const { path, body } = pickFixPath(cfg, act);
  log(`[monitor] auto-fix ${v.key} POST ${path}`);
  const fix = await httpPost(v.key, path, body);
  markFix(v.key, act);
  return { venue: v.key, code: 'AUTO_FIX', message: `${act} ok=${fix.ok}`, action: act, ok: fix.ok };
}

(async () => {
  const state0 = loadState();
  if (state0.stopped) {
    log('[monitor] 已标记停止（连续无问题达标），跳过');
    console.log(JSON.stringify({ ok: true, stopped: true, cleanStreak: state0.cleanStreak, issues: [] }));
    process.exit(2);
  }

  const allIssues = [];
  const fixes = [];
  const summary = [];
  const alertWindowMs = Number(process.env.GRID_MONITOR_ALERT_WINDOW_MS || 10 * 60_000);
  const alertCutoff = Date.now() - alertWindowMs;

  for (const v of VENUES) {
    const proc = await ensureProcess(v);
    if (proc.issue) allIssues.push(proc.issue);

    const live = await fetchVenueLiveState(v);
    const snap = live.snap || {};
    if (!snap.running && live.source === 'fail') {
      allIssues.push({ venue: v.key, code: 'SNAPSHOT_FAIL', message: 'refresh/state 均失败' });
      summary.push({ venue: v.key, ok: false, source: live.source });
      continue;
    }

    allIssues.push(...scanExchangeFreshness(v, live.refresh, live.source));
    const heavy = scanHeavyInventory(v, snap);

    const fh = snap.fleetHealth || fallbackHealth(snap, v);
    if (!fh.healthy) {
      allIssues.push(...scanAlerts(snap.alerts, v.key, alertCutoff));
    }
    allIssues.push(...scanStructure(v, snap, fh));

    const fix = await tryAutoFix(v, fh);
    if (fix) fixes.push(fix);

    summary.push({
      venue: v.key,
      healthy: fh.healthy,
      bots: snap.botCount,
      orders: snap.openOrders,
      accountOrders: snap.accountOpenOrders,
      action: fh.recommendAction,
      phase: fh.phase,
      source: live.source,
      refreshMs: live.refresh?.latencyMs,
      heavyInventory: heavy.map((h) => h.message),
    });
    log(`[monitor] ${v.label} src=${live.source} healthy=${fh.healthy} bots=${snap.botCount} orders=${snap.openOrders} action=${fh.recommendAction}`);
  }

  const dedup = [];
  const seen = new Set();
  for (const i of allIssues) {
    const k = `${i.venue}:${i.code}:${i.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(i);
  }

  const st = loadState();
  st.lastPollAt = Date.now();
  st.lastSummary = summary;
  st.lastFixes = fixes;

  if (dedup.length === 0) {
    st.cleanStreak = (st.cleanStreak || 0) + 1;
    st.lastIssues = [];
    log(`[monitor] 本轮无问题 cleanStreak=${st.cleanStreak}/${CLEAN_TARGET}`);
    if (st.cleanStreak >= CLEAN_TARGET) {
      st.stopped = true;
      saveState(st);
      log(`[monitor] 连续 ${CLEAN_TARGET} 轮无问题 → 停止轮询`);
      console.log(JSON.stringify({ ok: true, cleanStreak: st.cleanStreak, stop: true, summary, fixes }));
      process.exit(2);
    }
    saveState(st);
    console.log(JSON.stringify({ ok: true, cleanStreak: st.cleanStreak, issues: [], summary, fixes }));
    process.exit(0);
  }

  st.cleanStreak = 0;
  st.lastIssues = dedup;
  if (!st.history) st.history = [];
  st.history.unshift({ at: Date.now(), issues: dedup, fixes });
  st.history = st.history.slice(0, 20);
  saveState(st);

  log(`[monitor] 发现 ${dedup.length} 个问题，cleanStreak 归零`);
  for (const i of dedup.slice(0, 8)) log(`  - [${i.venue}] ${i.code}: ${i.message}`);
  console.log(JSON.stringify({ ok: false, cleanStreak: 0, issues: dedup, summary, fixes }));
  process.exit(1);
})().catch((e) => {
  log(`[monitor] fatal: ${e.message}`);
  process.exit(1);
});
