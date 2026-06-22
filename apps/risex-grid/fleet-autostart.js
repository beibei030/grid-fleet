import { buildFleetPlans, restartFleet } from './fleet-plan.js';

export async function autoStartFleet(fleet, exchange) {
  const st = fleet.getState();
  const slots = Number(process.env.RISE_ACTIVE_SLOTS || 3);
  const expected = slots * 18 * 0.85;
  if (st.botCount >= slots && st.openOrders >= expected) {
    console.log(`[Fleet] 已满 ${st.botCount} bot / ${st.openOrders} 单，跳过 autostart`);
    return;
  }
  if (st.botCount > 0 && st.botCount < slots) {
    console.log(`[Fleet] 仅 ${st.botCount}/${slots} bot，继续补槽启动…`);
  }
  console.log('[Fleet] 按账户余额自动规划并启动…');
  try {
    const eq = typeof exchange.equity === 'number' ? exchange.equity : exchange.balance;
    fleet.journal?.ensureBaseline(eq);
    const { preview, started } = await restartFleet(fleet, exchange, { closeFirst: false });
    console.log(`[Fleet] 权益 ${preview.balance}U · 预估保证金 ${preview.totalEstMarginUsd}U · 缓冲 ${preview.marginBufferUsd}U`);
    for (const p of preview.plans) {
      console.log(`  ${p.name} 得分${p.score ?? '—'} · ${p.leverage}x · ${p.gridCount}格 · ±${((p.rangeHalfPct || 0) * 100).toFixed(1)}% · size ${p.sizeBase}`);
    }
    for (const s of started) {
      if (s.error) console.log(`  ✗ ${s.name}: ${s.error}`);
      else console.log(`  ✓ ${s.name}: ${s.openOrders} 单`);
    }
    const st2 = fleet.getState();
    const slots = Number(process.env.RISE_ACTIVE_SLOTS || 3);
    const expected = slots * 18 * 0.85;
    const healthy = st2.botCount >= slots && st2.openOrders >= expected;
    console.log(`[Fleet] 完成 · ${st2.botCount} 标的 · ${st2.openOrders} 挂单 · healthy=${healthy}`);
    if (!healthy && st2.openOrders < expected) {
      const { recoverFleetSeeding } = await import('./fleet-seed.js');
      console.log('[Fleet] autostart 未达 85% 挂单，触发 seed 续铺…');
      await recoverFleetSeeding(fleet, exchange).catch((e) => console.warn('[Fleet] seed:', e.message));
    }
  } catch (e) {
    console.error('[Fleet] 自动启动失败:', e.message);
  }
}

export { buildFleetPlans, restartFleet };
