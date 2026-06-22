# 中性网格策略（三所通用）

## 目标

在 **±2.4%** 区间内通过对敲赚取格差；单边行情时 **移框跟随**，不默认清仓止损。

## 默认参数

| 参数 | Extended | RISEx | Decibel |
|------|----------|-------|---------|
| 槽位 | 3 (BTC/ETH/SOL) | 3 | 3 |
| gridCount | 24 | 18 | 22 |
| rangeHalfPct | 0.024 | 0.024 | 0.024 |
| leverage | 5x | 5x | 5x |
| skipBand | 0.10 | 0.10 | 0.10 |

## 铺单规则

1. **seed**：现价下方 buy、上方 sell（中性模式均非 reduce-only）
2. **成交后**：买成 → 上一格卖；卖成 → 下一格买（`replacementFor`）
3. **破区间**：`autoRecenter` / `shiftGrid` 以现价为中心重挂，**默认不平仓**

## 库存管理

- `maxInventoryMult = 4`：净多/净空超过 `4 × sizeBase` 时 **停止同向开仓**
- `CLOSE_COVER_RATIO = 0.7`：补 reduce-only 平仓侧挂单，目标覆盖持仓 70%
- 超过阈值时撤最远加仓单（RISEx `_cancelRiskAdds`）

## 舰队维护

- **偏少**（open < 35% 格）：`replenishIfEmpty`，**不 recenter**
- **脱节**（现价脱离挂单区且满格）：才 `recenter`
- **空槽**：`fleet-autostart` / `recoverFleetSeeding` 补 bot
- RISEx：autostart 必须 **满 3 槽** 才跳过，避免「1 bot + 链上单」卡死

## 数据口径（看板）

- 今日已实现优先 `todayOfficialRealized`（交易所官方）
- 总成交量为多口径合计，**不可**当终身成交直接相加
- 有 official 数据时静默同步 ledger，避免「基准重置」刷屏

## 单所一句话（给别的 bot 测试）

> ±2.4% 中性网格 18–24 格 5x，区间内对敲，破界移框，超 4 格限加+70% reduce-only 去库存，偏少只补铺。
