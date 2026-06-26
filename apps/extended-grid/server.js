// Zero-dependency HTTP + SSE server (Node built-ins only; undici only needed
// when using a proxy). Serves the dashboard, a small REST API, and pushes
// live bot state to the browser via Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from './config.js';
import { createExchange } from './exchange/index.js';
import { GridFleet } from './fleet.js';
import { GridJournal } from './journal.js';
import { autoStartFleet } from './fleet-autostart.js';
import { buildFleetPlans, restartFleet, CANDIDATE_NAMES } from './fleet-plan.js';
import { backfillJournalFromExchange } from './journal-backfill.js';
import { startFleetMaintainer } from './fleet-maintain.js';
import { isFleetPaused, pauseFleet, resumeFleet, closeAllPositions } from './fleet-control.js';
import { scoreCandidates } from './fleet-scanner.js';
import { analyzeTrend } from './trend.js';
import { setupProxy } from './proxy.js';
import { syncOfficialPnlSince } from './pnlSince.js';
import { attachFleetHealth } from './fleet-health.js';


const cfg = getConfig();
const proxyUsed = await setupProxy();
if (proxyUsed) console.log('[代理] 已启用: ' + proxyUsed);
else console.log('[代理] 未配置（程序将直连，国内可能连不上交易所）');
const exchange = createExchange(cfg);
const journal = new GridJournal();
await journal.load();
syncOfficialPnlSince(exchange, journal);
const fleet = new GridFleet(exchange, journal);
const clients = new Set();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function send(res, code, obj) {
  const body = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function tokenFromReq(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const q = url.searchParams.get('token');
  return q ? q.trim() : '';
}

function requireAuth(req, res, url) {
  if (!cfg.authToken) return true;
  const token = tokenFromReq(req, url);
  if (token !== cfg.authToken) {
    send(res, token ? 403 : 401, { error: token ? '密码无效' : '未提供访问密码' });
    return false;
  }
  return true;
}

process.on('uncaughtException', (e) => console.error('[Extended] uncaughtException:', e?.message ?? e));
process.on('unhandledRejection', (e) => console.error('[Extended] unhandledRejection:', e?.message ?? e));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/health') {
      return send(res, 200, { ok: true, auth_enabled: !!cfg.authToken, port: cfg.port });
    }

    if (p === '/api/meta') {
      return send(res, 200, { authRequired: !!cfg.authToken, port: cfg.port, network: cfg.network });
    }

    const needsAuth = cfg.authToken && p.startsWith('/api/') && p !== '/api/health' && p !== '/api/meta';
    if (needsAuth && !requireAuth(req, res, url)) return;

    if (p === '/api/markets') return send(res, 200, {
      mode: 'live',
      dataSource: exchange.dataSource || 'real',
      network: exchange.network || cfg.network,
      apiUrl: exchange.apiUrl || cfg.apiUrl,
      markets: await exchange.getMarkets(),
    });

    if (p === '/api/trend') {
      const marketId = Number(url.searchParams.get('marketId') || 1);
      const intervalSec = Number(url.searchParams.get('intervalSec') || 3600);
      let candles = [];
      try { candles = await exchange.getCandles(marketId, intervalSec, 200); } catch (e) { /* tolerate */ }
      let price = null; try { price = await exchange.getPrice(marketId); } catch {}
      const analysis = (candles && candles.length >= 20)
        ? analyzeTrend(candles)
        : { trend: 'range', recommended: 'neutral', strength: 0, atrPct: null, price,
            detail: '暂时拿不到足够K线数据，已默认中性网格。可手动设置上下边界后启动；不影响下单。' };
      return send(res, 200, { analysis, candles: (candles || []).slice(-120) });
    }

    if (p === '/api/state') return send(res, 200, fleet.getState());

    if (p === '/api/snapshot') return send(res, 200, attachFleetHealth(fleet.getState()));

    if (p === '/api/exchange/refresh' && req.method === 'POST') {
      try {
        const t0 = Date.now();
        await exchange._refreshAccount?.().catch(() => {});
        const accountAt = Date.now();
        await exchange._refreshAllPositions?.().catch(() => {});
        const positionsAt = Date.now();
        await exchange._refreshAllOpenOrders?.().catch(() => {});
        const ordersAt = Date.now();
        let openOrderCount = 0;
        if (typeof exchange.getCachedOpenOrders === 'function') {
          for (const m of exchange.markets?.values?.() || []) {
            openOrderCount += (exchange.getCachedOpenOrders(m.marketId) || []).length;
          }
        }
        const refresh = {
          ok: true, accountAt, positionsAt, ordersAt, openOrderCount,
          positionCount: exchange.getAllPositions?.()?.length ?? 0,
          latencyMs: ordersAt - t0,
        };
        return send(res, 200, { ok: true, refresh, state: attachFleetHealth(fleet.getState()) });
      } catch (e) { return send(res, 500, { error: e.message }); }
    }

    if (p === '/api/fleet/plan') {
      const balance = typeof exchange.balance === 'number' ? exchange.balance : null;
      if (balance == null) return send(res, 503, { error: '余额暂不可用' });
      const markets = await exchange.getMarkets();
      const runningIds = [...fleet.bots.values()].filter((b) => b.running).map((b) => b.config.marketId);
      const { pickActiveSelectionsValidated } = await import('./fleet-scanner.js');
      const selections = await pickActiveSelectionsValidated(exchange, { runningMarketIds: runningIds, balance, markets });
      return send(res, 200, buildFleetPlans({ balance, markets, selections }));
    }

    if (p === '/api/fleet/scan') {
      const rows = await scoreCandidates(exchange);
      return send(res, 200, { candidates: rows });
    }

    if (p === '/api/fleet/restart' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { setFleetPaused } = await import('./fleet-control.js');
        setFleetPaused(false);
        const closeFirst = body?.closeFirst === true;
        return send(res, 200, await restartFleet(fleet, exchange, { closeFirst }));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/fleet/recenter' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { recenterFleetBots } = await import('./fleet-maintain.js');
        const markets = body.markets || body.names || null;
        return send(res, 200, await recenterFleetBots(fleet, exchange, {
          markets: Array.isArray(markets) ? markets : (markets ? [markets] : null),
          force: body.force !== false,
        }));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/fleet/pause' && req.method === 'POST') {
      try { return send(res, 200, await pauseFleet(fleet)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/fleet/resume' && req.method === 'POST') {
      try { return send(res, 200, await resumeFleet(fleet, exchange)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/fleet/seed' && req.method === 'POST') {
      try {
        const { recoverFleetSeeding } = await import('./fleet-seed.js');
        return send(res, 200, await recoverFleetSeeding(fleet, exchange));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/fleet/start' && req.method === 'POST') {
      try { return send(res, 200, await resumeFleet(fleet, exchange)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/fleet/cancel-orders' && req.method === 'POST') {
      try {
        await pauseFleet(fleet);
        const before = fleet.getState().openOrders ?? 0;
        const after = fleet.getState().openOrders ?? 0;
        return send(res, 200, { ok: true, cancelled: Math.max(0, before - after), state: fleet.getState() });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/fleet/converge' && req.method === 'POST') {
      try {
        const { recoverFleetSeeding } = await import('./fleet-seed.js');
        const converged = [];
        await exchange._refreshAllOpenOrders?.().catch(() => {});
        for (const b of fleet.bots.values()) {
          if (!b.running) continue;
          const h = b.checkGridHealth?.();
          if (!h?.overFilled && !h?.hardOverFilled) continue;
          const cached = b._liveOpenOrders?.() || [];
          const r = await b.trimExcessOrders?.(cached, {
            target: h.softMaxOrders,
            maxCancel: Number(process.env.EXT_CONVERGE_MAX_CANCEL || process.env.RISE_CONVERGE_MAX_CANCEL || 8),
          }).catch((e) => ({ error: e.message }));
          converged.push({ market: b.config?.displayName || 'bot', ...r });
        }
        const seed = await recoverFleetSeeding(fleet, exchange);
        return send(res, 200, { ok: true, converged, ...seed, state: attachFleetHealth(fleet.getState()) });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/fleet/close-positions' && req.method === 'POST') {
      try {
        const r = await closeAllPositions(exchange);
        return send(res, 200, { ok: true, ...r, state: fleet.getState() });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/journal/backfill' && req.method === 'POST') {
      try {
        const r = await backfillJournalFromExchange(exchange, journal);
        return send(res, 200, { ok: true, ...r, fillCount: journal.getFills(9999).length });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/session/reset' && req.method === 'POST') {
      try {
        await exchange._refreshOfficialStats?.().catch(() => {});
        const eq = typeof exchange.equity === 'number' ? exchange.equity : exchange.balance;
        const r = journal.resetSession(eq);
        syncOfficialPnlSince(exchange, journal);
        exchange._statsCache = null;
        return send(res, 200, { ok: true, ...r, equity: eq });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/start' && req.method === 'POST') {
      try { return send(res, 200, await fleet.start(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/stop' && req.method === 'POST') {
      try { return send(res, 200, await fleet.stop(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(fleet.getState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    let file = p === '/' ? '/index.html' : p;
    const full = path.join(ROOT, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return fs.createReadStream(full).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});

setInterval(() => {
  const data = `data: ${JSON.stringify(fleet.getState())}\n\n`;
  for (const res of clients) { try { res.write(data); } catch { clients.delete(res); } }
}, 1000);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${cfg.port} 已被占用——很可能之前那个程序窗口还在运行。`);
    console.error('请先关闭之前的黑色命令行窗口（或在里面按 Ctrl+C），再启动本程序。');
    console.error('或在 .env 里改 PORT=8082 用别的端口。\n');
  } else {
    console.error('[服务器错误] ' + (e?.message || e));
  }
  process.exit(1);
});

try {
  await exchange.init();
  exchange.statsMarketNames = CANDIDATE_NAMES;
  exchange._refreshOfficialStats().catch(() => {});
} catch (e) {
  console.error('\n[启动失败] 无法连接 Extended 接口：' + (e?.message || e));
  process.exit(1);
}

async function maybeBackfillJournal() {
  if (journal.getFills(1).length > 0) return;
  console.log('[Journal] 本地无成交记录，正在从 Extended 回填历史…');
  try {
    const r = await backfillJournalFromExchange(exchange, journal);
    console.log(`[Journal] 回填完成：新增 ${r.added} 条，跳过 ${r.skipped} 条（API 共 ${r.total} 条）`);
  } catch (e) {
    console.warn('[Journal] 回填失败:', e.message);
  }
}

await maybeBackfillJournal();
server.listen(cfg.port, async () => {
  console.log('\nExtended 网格机器人已启动 [实盘 LIVE]');
  console.log(`仪表盘: http://localhost:${cfg.port}`);
  console.log(`行情数据源: 实时 (${exchange.network}) ${exchange.apiUrl || ''}`);
  console.log('⚠️ 实盘模式：将使用真实资金在 Extended 主网下单。');
  if (cfg.authToken) console.log('🔒 看板/API 已启用密码保护（与对冲 hedge-token 相同）。\n');
  else console.log('');
  if (process.env.FLEET_AUTOSTART === '1') {
    setTimeout(async () => {
      try { await autoStartFleet(fleet, exchange); } catch (e) { console.error('[Fleet] 自动启动失败:', e.message); }
    }, 60_000);
  }
  startFleetMaintainer(fleet, exchange);
  console.log('[Fleet] 固定 BTC/ETH/SOL 三标 + DGT 移框 + 空转自愈已启用\n');
});
