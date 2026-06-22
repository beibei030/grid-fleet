import { buildFleetPlans, restartFleet, ACTIVE_SLOTS, FLEET_DEFAULTS } from './fleet-plan.js';
import { syncOfficialPnlSince } from './pnlSince.js';
import { recoverFleetSeeding } from './fleet-seed.js';

export async function autoStartFleet(fleet, exchange) {
  const st = fleet.getState();
  const gc = FLEET_DEFAULTS.UNIFIED_GRID_COUNT;
  const expected = ACTIVE_SLOTS * Math.max(6, Math.floor(gc * 0.85));
  if (st.botCount >= ACTIVE_SLOTS && st.openOrders >= expected) {
    console.log(`[Fleet] 已有 ${st.botCount} bot / ${st.openOrders} 单，跳过 autostart`);
    return;
  }
  console.log('[Fleet] 按账户余额自动规划并启动…');
  try {
    const eq = typeof exchange.equity === 'number' ? exchange.equity : exchange.balance;
    fleet.journal?.ensureBaseline(eq);
    syncOfficialPnlSince(exchange, fleet.journal);
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
    const healthy = st2.botCount >= ACTIVE_SLOTS && st2.openOrders >= expected;
    console.log(`[Fleet] 完成 · ${st2.botCount} 标的 · ${st2.openOrders} 挂单 · healthy=${healthy}`);
    if (!healthy) {
      console.log('[Fleet] autostart 未达 85% 挂单，触发 seed 续铺…');
      await recoverFleetSeeding(fleet, exchange).catch((e) => console.warn('[Fleet] seed:', e.message));
    }
  } catch (e) {
    console.error('[Fleet] 自动启动失败:', e.message);
  }
}

export { buildFleetPlans, restartFleet };
