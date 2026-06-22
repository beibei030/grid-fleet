import type { Express } from "express";
import { config as appConfig } from "../config.js";
import { enrichGridFleetState } from "./gridStateEnrich.js";
import { gridAuthMiddleware } from "./attachGridUi.js";
import { cancelAccountOpenOrders, closeAllPositions, pauseFleet, resumeFleet, setFleetPaused } from "./fleetControl.js";
import type { GridAdapterExtras } from "./gridLiveTypes.js";
import type { VenueGridManager } from "./gridManager.js";
import { attachFleetHealth } from "./fleetHealth.js";
import { forceExchangeRefresh } from "./exchangeRefresh.js";

export interface GridStandaloneOpts {
  manager: VenueGridManager;
  authToken: string;
  port: number;
  exchangeLabel: string;
  activeSlots: number;
  mode?: string;
}

/** Extended :8081 同款 REST API（Decibel / Ondo 独立网格共用） */
export function registerGridStandaloneApi(app: Express, opts: GridStandaloneOpts): {
  getEnrichedState: () => Promise<Record<string, unknown>>;
} {
  const { manager, authToken, port, exchangeLabel, activeSlots, mode = appConfig.mode } = opts;

  async function getEnrichedState() {
    return enrichGridFleetState(manager, { activeSlots });
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, auth_enabled: !!authToken, port, exchange: exchangeLabel });
  });

  app.get("/api/meta", (_req, res) => {
    const adapter = manager.exchangeAdapter as GridAdapterExtras | null;
    res.json({
      authRequired: !!authToken,
      port,
      network: adapter?.network ?? mode,
      exchange: exchangeLabel,
    });
  });

  app.use("/api", gridAuthMiddleware(authToken));

  app.post("/api/exchange/refresh", async (_req, res) => {
    try {
      const adapter = manager.exchangeAdapter;
      const refresh = await forceExchangeRefresh(adapter, exchangeLabel);
      const state = await getEnrichedState();
      res.json({ ok: refresh.ok, refresh, state: attachFleetHealth(state, activeSlots) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  /** 总看板聚合用：内存快照，不拉链上挂单/官方 API，避免 enrich 阻塞 */
  app.get("/api/snapshot", (_req, res) => {
    const raw = manager.getState();
    res.json(attachFleetHealth(raw, activeSlots));
  });

  app.get("/api/state", async (_req, res) => {
    res.json(await getEnrichedState());
  });

  app.get("/api/markets", async (_req, res) => {
    try {
      const adapter = manager.exchangeAdapter;
      if (!adapter) return res.status(503).json({ error: "适配器未就绪" });
      const markets = await adapter.getMarkets();
      const extra = adapter as GridAdapterExtras;
      res.json({
        mode: adapter.mode,
        dataSource: extra.dataSource ?? "real",
        network: extra.network ?? "mainnet",
        markets: markets.map((m) => ({
          marketId: m.marketId,
          displayName: m.displayName,
          symbol: m.symbol,
          lastPrice: m.lastPrice,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.get("/api/fleet/scan", async (_req, res) => {
    try {
      const data = await manager.scan();
      res.json({ candidates: data.rows, ...data });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.get("/api/fleet/plan", async (_req, res) => {
    try {
      const data = await manager.plan();
      const preview = data.preview;
      if (!preview) return res.status(503).json({ error: "规划失败" });
      res.json(preview);
    } catch (e: any) {
      res.status(503).json({ error: e?.message ?? "余额暂不可用" });
    }
  });

  app.get("/api/trend/:symbol", async (req, res) => {
    try {
      const data = await manager.trend(String(req.params.symbol));
      res.json(data);
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.post("/api/fleet/start", async (_req, res) => {
    try {
      setFleetPaused(false);
      await manager.autostart();
      res.json({ ok: true, state: await getEnrichedState() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.post("/api/fleet/restart", async (req, res) => {
    try {
      setFleetPaused(false);
      const closeFirst = req.body?.closeFirst === true;
      const r = await manager.restart(closeFirst);
      manager.resetRoundBaseline();
      res.json({ ok: true, ...r, state: await getEnrichedState() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.post("/api/fleet/pause", async (_req, res) => {
    try {
      const fleet = manager.gridFleet;
      if (!fleet) return res.status(400).json({ error: "网格未启用" });
      await pauseFleet(fleet, manager.exchangeAdapter);
      res.json({ ok: true, state: await getEnrichedState() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.post("/api/fleet/resume", async (_req, res) => {
    try {
      const fleet = manager.gridFleet;
      if (!fleet) return res.status(400).json({ error: "网格未启用" });
      setFleetPaused(false);
      if (!fleet.runningMarketIds().length) {
        const r = await manager.restart(false);
        res.json({ ok: true, ...r, state: await getEnrichedState() });
      } else {
        const adapter = manager.exchangeAdapter;
        if (!adapter) return res.status(400).json({ error: "网格未启用" });
        await resumeFleet(fleet, adapter, manager.fleetOptsPublic());
        manager.startMaintainer();
        res.json({ ok: true, state: await getEnrichedState() });
      }
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.post("/api/fleet/converge", async (_req, res) => {
    try {
      const r = await manager.converge();
      res.json({ ok: true, ...r, state: await getEnrichedState() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.post("/api/fleet/cancel-orders", async (_req, res) => {
    try {
      const adapter = manager.exchangeAdapter;
      if (!adapter) return res.status(400).json({ error: "网格未启用" });
      const cancelled = await cancelAccountOpenOrders(adapter);
      res.json({ ok: true, cancelled, state: await getEnrichedState() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.post("/api/fleet/close-positions", async (_req, res) => {
    try {
      setFleetPaused(true);
      const adapter = manager.exchangeAdapter;
      if (!adapter) return res.status(400).json({ error: "网格未启用" });
      await manager.stopAll(false);
      const r = await closeAllPositions(adapter);
      res.json({ ok: true, ...r, state: await getEnrichedState() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.post("/api/stop", async (req, res) => {
    const closePosition = req.body?.closePosition !== false;
    setFleetPaused(true);
    await manager.stopAll(closePosition);
    res.json({ ok: true, state: await getEnrichedState() });
  });

  app.post("/api/session/reset", async (_req, res) => {
    try {
      const state = manager.resetRoundBaseline();
      res.json({
        ok: true,
        baselineEquity: state?.baselineEquity ?? null,
        equity: state?.equity ?? state?.balance,
        state: await getEnrichedState(),
      });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  return { getEnrichedState };
}
