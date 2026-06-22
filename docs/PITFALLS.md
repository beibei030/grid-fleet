# 踩坑记录（生产运维总结）

实盘三所网格踩过的坑。**不含账户、IP、密钥。**

---

## Extended

### 国内网络 / API 不可达

- **现象**：超时，看板有进程但无行情
- **修复**：`HTTPS_PROXY` 或本地代理；RISEx / Decibel 通常可直连

### `reduceOnly is not defined`

- **现象**：下单崩溃，整 bot 停挂
- **原因**：`extended.js` 里 `!!reduceOnly` 应为 `!!o.reduceOnly`

### 启动时 1137: Position is missing for reduce-only

- **现象**：某标的 0 单，告警刷屏
- **原因**：无持仓仍下 reduce-only；或 `_seeding` 期间误标 reduce-only
- **修复**：无持仓跳过 reduce-only；铺单期不强制 reduce-only

### 异步 API

- 必须 poll 订单状态，不能 assume 立即挂单成功

---

## RISEx

### 误以为是「固定 10 秒一笔」

- **误解**：链上固定 10s/tx，满铺一定要十几分钟
- **实际**：账户有 **tx quota**，超限才 `429`；quota 随账户/网络变化，**非固定常量**
- **本库**：写操作串行队列 + 429 退避，单进程正常维护可铺满
- **真凶**：并行 `restart` + `autostart` + 多个 fix 脚本 → **无意义 cancel/place 风暴** 才快速耗尽 quota

### 频繁 reload 导致永远铺不满

- **勿**：SSH 长连等铺单时又触发第二次 restart
- **勿**：链上已有单仍 `cancelAll` 全量重铺
- **应**：承接已有单、只补缺口；用 `/api/snapshot` 轮询，单次维护跑完

### `closeFirst` 误走 query string

- `fleet/restart?closeFirst=true` 不生效，必须 **POST body** `{ closeFirst: true }`

### `ReduceOnlyOrderNotReducingPosition` / PlaceOrder revert 500

- reduce-only 尺寸 > 持仓；或卖单已覆盖仍硬补
- **修复**：按持仓 clip；卖单总量 ≥95% 持仓则不再补

### autostart 只起 1 bot

- `botCount>0 && openOrders>4` 就 skip → 卡死
- **修复**：仅当 `botCount >= slots && openOrders >= 85%` 才 skip

---

## Decibel

### 挂单偏少 → recenter 风暴

- `convergeOverflowGrids` 把「偏少」当「脱节」全撤重挂
- **修复**：偏少走 `replenishIfEmpty`；未满格不算脱节

### Aptos open 索引延迟

- place 后短时 poll 空 → 误判无单 → 重复铺单
- **修复**：空列表重试；`trackedHere>0` 且 API 空则跳过本轮

### clientOrderId / orderId 不一致

- **修复**：按 clientOrderId remap

### 凭证配错

- `DECIBEL_API_KEY` 是 Geomi **Node API Key**，不是网页登录密码
- 私钥是 **Aptos Ed25519**；`DECIBEL_SUBACCOUNT` 多数情况留空即可
- 见 [SETUP.md](SETUP.md)

---

## 总看板

### 今日盈亏「基准重置」刷屏

- `venueOpen.realized` 微抖触发 `pushChange`
- 有 `todayOfficialRealized` 或 dip<5U 时静默同步

### snapshot vs 交易所实时

- `/api/snapshot` 为内存快照；巡检应走 `POST /api/exchange/refresh`

---

## 运维冲突（通用）

1. **每个 grid 进程仅一个实例**（一个 LISTENING）
2. **勿** autostart 与 `fleet/restart` 并行（`fleetRestarting` 锁）
3. **勿**把 RISEx 专用修复脚本套到 Extended / Decibel（代码库不同）
4. Decibel 的 `fleet/restart` 入口与 Extended/RISEx 略有差异

---

## 策略边界

- **不会**因仓位大自动市价全平（除非显式 `autoStopOutOfRange`）
- **不会**因趋势自动砍仓；靠对敲 + reduce-only 去库存
- 极端情况：交易所强平（需自行监控保证金）

---

## API 文档

| 所 | 文档 |
|----|------|
| Extended | https://api.docs.extended.exchange/ |
| RISEx | https://developer.rise.trade/reference/integration |
| Decibel | https://docs.decibel.trade/developer-hub/on-chain/overview |
