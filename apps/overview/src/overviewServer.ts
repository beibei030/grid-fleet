/**
 * 三所网格总看板，聚合各 grid 进程只读状态，移动端优先。
 */
import cors from "cors";
import dotenv from "dotenv";
import express, { type Response } from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildGridOverview } from "./core/gridOverview.js";
import { startOverviewTelegramScheduler } from "./core/overviewTelegram.js";
import { gridAuthMiddleware } from "./grid/attachGridUi.js";
import { log, muteTelegram } from "./util/logger.js";
import { acquireSingleInstance } from "./util/singleInstance.js";

dotenv.config();

const port = Number(process.env.OVERVIEW_PORT || process.env.PORT || 0);
if (!port) {
  console.error("请在 .env 设置 OVERVIEW_PORT");
  process.exit(1);
}
const authToken = process.env.GRID_AUTH_TOKEN || config.authToken;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

function renderOverviewHtml(): string {
  const htmlPath = path.join(PUBLIC_DIR, "index.html");
  return fs.readFileSync(htmlPath, "utf8");
}

async function main() {
  muteTelegram(true);
  acquireSingleInstance("grid-overview.pid");

  const app = express();
  app.use(cors({ origin: true, methods: ["GET"] }));
  app.use(express.json());

  const clients = new Set<Response>();

  async function pushState() {
    const payload = await buildGridOverview();
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.write(data);
      } catch {
        clients.delete(client);
      }
    }
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, auth_enabled: !!authToken, port, service: "grid-overview" });
  });

  app.get("/api/meta", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      authRequired: !!authToken,
      port,
      venues: [
        { key: "extended", label: "Extended", url: config.gridFleet.url },
        { key: "risex", label: "RISEx", url: config.risexGridFleet.url },
        { key: "decibel", label: "Decibel", url: config.decGridFleet.url },
      ],
    });
  });

  app.use("/api", gridAuthMiddleware(authToken));

  app.get("/api/overview", async (_req, res) => {
    res.json(await buildGridOverview());
  });

  app.get("/api/stream", (req, res) => {
    if (authToken) {
      const h = req.headers.authorization || "";
      let token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
      if (!token && typeof req.query.token === "string") token = req.query.token.trim();
      if (token !== authToken) {
        res.status(401).end();
        return;
      }
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    void buildGridOverview().then((st) => {
      res.write(`data: ${JSON.stringify(st)}\n\n`);
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  const timer = setInterval(() => void pushState(), 3000);
  timer.unref();

  app.get("/", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.type("html").send(renderOverviewHtml());
  });

  app.get("/index.html", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.type("html").send(renderOverviewHtml());
  });

  const server = http.createServer(app);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`端口 ${port} 已被占用，网格总看板退出`);
      process.exit(1);
    }
    log.error(`HTTP 异常: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, () => {
    log.info(`网格总看板 | http://0.0.0.0:${port} | 聚合 Extended / RISEx / Decibel`);
    startOverviewTelegramScheduler(buildGridOverview);
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
