import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../grid-public");

type StateFn = () => Promise<Record<string, unknown>> | Record<string, unknown>;

/** 独立网格进程：Extended 同款静态看板 + SSE（:8081 / :8083 / :8084） */
export function attachGridStandaloneUi(
  app: Express,
  getState: StateFn,
  opts: {
    pageTitle?: string;
    exchangeLabel?: string;
    authToken?: string;
    activeSlots?: number;
    slotLabel?: string;
    subtitle?: string;
  } = {}
): void {
  const clients = new Set<Response>();
  const authToken = opts.authToken ?? "";

  async function pushState() {
    const st = await Promise.resolve(getState());
    const payload = `data: ${JSON.stringify(st)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

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
    void Promise.resolve(getState()).then((st) => {
      res.write(`data: ${JSON.stringify(st)}\n\n`);
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  const timer = setInterval(() => void pushState(), 2500);
  timer.unref();

  app.get("/", (_req, res) => {
    res.type("html").send(renderGridHtml(opts));
  });

  app.get("/index.html", (_req, res) => {
    res.type("html").send(renderGridHtml(opts));
  });

  app.use(express.static(PUBLIC_DIR, { index: false }));
}

function renderGridHtml(opts: {
  pageTitle?: string;
  exchangeLabel?: string;
  activeSlots?: number;
  slotLabel?: string;
  subtitle?: string;
}): string {
  const htmlPath = path.join(PUBLIC_DIR, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  const pageTitle = opts.pageTitle ?? "网格";
  const exchangeLabel = opts.exchangeLabel ?? "Grid";
  const activeSlots = String(opts.activeSlots ?? 3);
  const slotLabel = opts.slotLabel ?? (Number(activeSlots) >= 3 ? "三标" : `${activeSlots}槽`);
  const subtitle = opts.subtitle ?? "";
  const inject = `<script>window.__GRID_UI__=${JSON.stringify({ pageTitle, exchangeLabel, activeSlots, slotLabel, subtitle })};</script>`;
  html = html.replace("</head>", `${inject}\n</head>`);
  return html
    .split("__PAGE_TITLE__").join(pageTitle)
    .split("__EXCHANGE__").join(exchangeLabel)
    .split("__ACTIVE_SLOTS__").join(activeSlots)
    .split("__SLOT_LABEL__").join(slotLabel)
    .split("__SUBTITLE__").join(subtitle);
}

/** 鉴权：支持 Bearer 与 ?token=（EventSource 用） */
export function gridAuthMiddleware(authToken: string) {
  return (req: Request, res: Response, next: () => void) => {
    if (!authToken) return next();
    const h = req.headers.authorization || "";
    let token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!token && typeof req.query.token === "string") token = req.query.token.trim();
    if (!token) return res.status(401).json({ ok: false, error: "未提供访问密码" });
    if (token !== authToken) return res.status(403).json({ ok: false, error: "密码无效" });
    next();
  };
}
