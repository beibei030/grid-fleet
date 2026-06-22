/**
 * Decibel 网格独立进程（:8083），看板与 API 对齐 extended-grid :8081。
 */
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import http from "node:http";
import { config } from "../config.js";
import { createExchanges } from "../exchanges/index.js";
import { log, muteTelegram } from "../util/logger.js";
import { acquireSingleInstance } from "../util/singleInstance.js";
import { attachGridStandaloneUi } from "./attachGridUi.js";
import { setFleetPaused } from "./fleetControl.js";
import { registerGridStandaloneApi } from "./gridStandaloneApi.js";
import { VenueGridManager } from "./gridManager.js";

dotenv.config();

const port = Number(process.env.DEC_GRID_PORT || process.env.PORT || 8083);
const authToken = process.env.GRID_AUTH_TOKEN || config.authToken;

const decManager = new VenueGridManager(
  "dec",
  "Decibel",
  true,
  config.decGrid.slots,
  config.decGrid.candidates,
  config.decGrid.preferSymbols
);

async function autostartWithRetry(manager: VenueGridManager, slots: number): Promise<void> {
  const delays = [0, 30_000, 90_000, 180_000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      await manager.autostart();
      const st = manager.getState();
      if (st?.running && (st.botCount ?? 0) >= slots && (st.openOrders ?? 0) > 0) {
        log.info(`[Grid/Decibel] autostart 成功（第 ${i + 1} 次）`);
        return;
      }
      log.warn(`[Grid/Decibel] autostart 第 ${i + 1} 次未拉满：bots=${st?.botCount} orders=${st?.openOrders}`);
    } catch (e: unknown) {
      log.error(`[Grid/Decibel] autostart 第 ${i + 1} 次失败: ${(e as Error)?.message ?? e}`);
    }
  }
  log.error("[Grid/Decibel] autostart 多次失败，空转看门狗将在 5 分钟内尝试恢复");
}

async function main() {
  muteTelegram(true);
  acquireSingleInstance("decibel-grid.pid");

  const ex = createExchanges();
  try {
    await ex.decibel.init();
  } catch (e: any) {
    log.error(`Decibel 初始化失败: ${e?.message}`);
    if (config.mode !== "paper") process.exit(1);
  }

  await decManager.init(ex);

  // AUTOSTART=false：仅开看板，maintainer 不得自动补槽挂单
  if (!config.decGrid.autostart) {
    setFleetPaused(true);
    log.info("[Grid/Decibel] AUTOSTART=false，舰队已暂停（需手动点「启动」才交易）");
  }

  const app = express();
  app.use(cors({ origin: true, methods: ["GET", "POST"] }));
  app.use(express.json());

  const api = registerGridStandaloneApi(app, {
    manager: decManager,
    authToken,
    port,
    exchangeLabel: "Decibel",
    activeSlots: config.decGrid.slots,
  });

  attachGridStandaloneUi(app, () => api.getEnrichedState(), {
    pageTitle: "Decibel 网格",
    exchangeLabel: "Decibel",
    authToken,
    activeSlots: config.decGrid.slots,
    slotLabel: config.decGrid.slots >= 3 ? "三标" : `${config.decGrid.slots}槽`,
  });

  decManager.startMaintainer();

  const server = http.createServer(app);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`端口 ${port} 已被占用，Decibel 网格退出`);
      process.exit(1);
    }
    log.error(`HTTP 异常: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, () => {
    log.info(
      `Decibel 网格 | 看板 http://0.0.0.0:${port} | slots=${config.decGrid.slots} | ${config.decGrid.candidates} | autostart=${config.decGrid.autostart}`
    );
    if (config.decGrid.autostart) {
      void autostartWithRetry(decManager, config.decGrid.slots);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.on("uncaughtException", (e) => {
  log.error(`未捕获异常: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
process.on("unhandledRejection", (r) => {
  log.error(`未处理的 Promise 拒绝: ${r instanceof Error ? r.stack ?? r.message : String(r)}`);
});
