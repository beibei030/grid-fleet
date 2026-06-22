/** 单笔对冲扣费后净盈亏（实现盈亏 − 本笔手续费） */
export function roundNetUsd(realized: number, fees: number): number {
  return realized - fees;
}

/** 用户可读：赚 $X / 亏 $X / 持平 */
export function formatRoundNetLabel(realized: number, fees: number): string {
  const net = roundNetUsd(realized, fees);
  if (Math.abs(net) < 0.005) return "持平 $0.00";
  return net > 0 ? `赚 $${net.toFixed(2)}` : `亏 $${Math.abs(net).toFixed(2)}`;
}

export function shortCloseReason(reason: string): string {
  if (/腿差|对冲失效|数量偏差|数量不一致/.test(reason)) return "腿差";
  if (/手动|一键/.test(reason)) return "手动";
  if (/net 锁利|组内Δ/.test(reason)) return "锁利";
  if (/整对.*止盈|整对.*止损|TP|SL|止盈|止损/.test(reason)) return "止盈止损";
  if (/缺腿|断腿/.test(reason)) return "断腿";
  if (/资金费/.test(reason)) return "资金费";
  if (/超时|48/.test(reason)) return "超时";
  if (/原生/.test(reason)) return "原生TP/SL";
  if (/回撤|急停/.test(reason)) return "风控";
  if (/只有一边|回滚|failed/i.test(reason)) return "开仓失败";
  return "其它";
}
