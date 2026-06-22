import { config } from "../config.js";
import { formatRoundNetLabel } from "../core/roundPnl.js";

const API = "https://api.telegram.org/bot";

export async function tgSend(text: string, chatId?: string): Promise<boolean> {
  const enabled = config.telegram.enabled || config.overviewTelegram.enabled;
  if (!enabled || !config.telegram.botToken) return false;
  const ids = chatId ? [chatId] : config.telegram.chatIds;
  if (!ids.length) return false;
  let ok = true;
  for (const id of ids) {
    try {
      const res = await fetch(`${API}${config.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
        }),
      });
      const j = (await res.json()) as { ok?: boolean };
      if (!j.ok) ok = false;
    } catch {
      ok = false;
    }
  }
  return ok;
}

export function notifyOpen(d: {
  id: string;
  symbol: string;
  longEx: string;
  shortEx: string;
  notional: number;
  leverage: number;
}) {
  void tgSend(
    [
      "🟢【开仓】" + d.symbol,
      `$${d.notional.toFixed(0)}/边 ${d.leverage}x`,
      `${d.longEx} 多 / ${d.shortEx} 空`,
      `#${d.id.slice(0, 8)}`,
    ].join("\n")
  );
}

export function notifyClose(d: {
  id: string;
  symbol: string;
  reason: string;
  realized: number;
  fees: number;
}) {
  const label = formatRoundNetLabel(d.realized, d.fees);
  const emoji = d.realized - d.fees >= 0 ? "💰" : "📉";
  void tgSend(
    [`${emoji}【平仓】${d.symbol}`, `本笔：${label}`, `原因：${d.reason}`, `#${d.id.slice(0, 8)}`].join("\n")
  );
}

export function notifyAlert(level: "risk" | "warn" | "error", msg: string) {
  const icon = level === "error" ? "🔴" : level === "risk" ? "🟣" : "🟡";
  void tgSend(`${icon}【${level.toUpperCase()}】\n${msg}`);
}

/** 腿差 / 断腿风控（Telegram） */
export function notifyLegRisk(d: {
  id: string;
  symbol: string;
  longSize: number;
  shortSize: number;
  action: "alert" | "close" | "verify_fail";
}) {
  const pct =
    Math.abs(d.longSize - d.shortSize) / Math.max(d.longSize, d.shortSize, 1e-9);
  const title =
    d.action === "close"
      ? "🚨【腿差强平】"
      : d.action === "verify_fail"
        ? "🚨【开仓验腿失败】"
        : "⚠️【腿差告警】";
  void tgSend(
    [
      `${title}${d.symbol}`,
      `多 ${d.longSize} / 空 ${d.shortSize}（偏差 ${(pct * 100).toFixed(1)}%）`,
      d.action === "close" ? "已触发整对强制平仓" : "请留意看板/日志",
      `#${d.id.slice(0, 8)}`,
    ].join("\n")
  );
}

/** 网格破区间暂停 */
export function notifyGridPause(d: {
  symbol: string;
  mark: number;
  center: number;
  rangePct: number;
  reason: string;
}) {
  void tgSend(
    [
      "⏸️【网格暂停】" + d.symbol,
      `现价 $${d.mark.toFixed(2)} 超出 ±${(d.rangePct * 100).toFixed(1)}%`,
      `中心 $${d.center.toFixed(2)} | ${d.reason}`,
    ].join("\n")
  );
}

/** Harvest 平盈利腿落袋 */
export function notifyHarvestCashOut(d: {
  id: string;
  symbol: string;
  winner: "long" | "short";
  anchor: "long" | "short";
  realized: number;
  source: "exchange" | "fallback";
  sessionTotal: number;
  harvestCount: number;
}) {
  const leg = (s: "long" | "short") => (s === "long" ? "多" : "空");
  void tgSend(
    [
      "🌾【Harvest 落袋】" + d.symbol,
      `平${leg(d.winner)}腿 +$${d.realized.toFixed(2)} (${d.source})`,
      `锚${leg(d.anchor)}腿 | 本组累计 $${d.sessionTotal.toFixed(2)} · 第 ${d.harvestCount} 次`,
      `#${d.id.slice(0, 8)}`,
    ].join("\n")
  );
}

/** Harvest 补对冲恢复 paired */
export function notifyHarvestRehedge(d: {
  id: string;
  symbol: string;
  side: "long" | "short";
  longSize: number;
  shortSize: number;
  sessionTotal: number;
  netUnrealized?: number;
}) {
  const leg = d.side === "long" ? "多" : "空";
  const round =
    d.netUnrealized != null ? d.sessionTotal + d.netUnrealized : undefined;
  void tgSend(
    [
      "🔗【Harvest 补腿】" + d.symbol,
      `补${leg}腿 多${d.longSize.toFixed(4)}/空${d.shortSize.toFixed(4)} → paired`,
      `本组已落袋 $${d.sessionTotal.toFixed(2)}` +
        (round != null ? ` | 整轮约 $${round.toFixed(2)}` : ""),
      `#${d.id.slice(0, 8)}`,
    ].join("\n")
  );
}
