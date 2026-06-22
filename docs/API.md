# HTTP API 参考

各 grid 进程（Extended / RISEx / Decibel）暴露**同一套** REST 风格接口（Decibel 由 `gridStandaloneApi.ts` 对齐 Extended）。总看板 Overview 为**只读聚合**，接口较少。

**Base URL**：`http://127.0.0.1:<PORT>`（与各 app `.env` 中 `PORT` / `DEC_GRID_PORT` / `OVERVIEW_PORT` 一致）

**认证**：若配置了 `GRID_AUTH_TOKEN`，除 `/api/health`、`/api/meta` 外，请求头需：

```http
Authorization: Bearer <GRID_AUTH_TOKEN>
```

---

## 通用（三所 grid）

### 健康与元信息

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 进程存活 |
| GET | `/api/meta` | 端口、认证是否开启、市场列表等 |

### 状态快照（推荐巡检用）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/snapshot` | 内存快照 + 舰队健康摘要（**轻量，适合轮询**） |
| GET | `/api/state` | 完整 state（比 snapshot 重，含 bot 细节） |
| POST | `/api/exchange/refresh` | 拉交易所最新余额/持仓/订单后再读 state |

### 市场与趋势

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/markets` | 可交易标的 |
| GET | `/api/trend` | Extended/RISEx 趋势摘要 |
| GET | `/api/trend/:symbol` | Decibel 单标的趋势 |

### 舰队控制

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/fleet/plan` | 当前舰队计划（槽位、参数） |
| GET | `/api/fleet/scan` | 扫描空槽/异常 |
| POST | `/api/fleet/start` | 启动舰队 |
| POST | `/api/fleet/pause` | 暂停（不撤单） |
| POST | `/api/fleet/resume` | 恢复 |
| POST | `/api/fleet/restart` | 重启舰队；body 可 `{ "closeFirst": true }`（**必须 JSON body**） |
| POST | `/api/fleet/converge` | 收敛网格（偏少补铺 / 脱节 recenter，视实现） |
| POST | `/api/fleet/cancel-orders` | 撤所有挂单 |
| POST | `/api/fleet/close-positions` | 平仓（慎用） |
| POST | `/api/fleet/recenter` | 移框（Extended/RISEx） |
| POST | `/api/fleet/seed` | 手动 seed（Extended/RISEx） |

### Bot / 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/start` | 启动 bot |
| POST | `/api/stop` | 停止 bot |
| POST | `/api/session/reset` | 重置会话统计 |
| POST | `/api/journal/backfill` | 补 journal（Extended/RISEx） |

### 实时推送

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stream` | SSE，推送 state/snapshot 更新 |

### 看板

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | Web 看板 HTML |

---

## Overview（总看板）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/meta` | 三所 URL 配置摘要 |
| GET | `/api/overview` | 聚合 JSON（equity、bot、持仓、ledger） |
| GET | `/api/stream` | SSE 聚合推送 |
| GET | `/` | 总看板 HTML |

Overview **不下单**；仅 HTTP 拉各所 `/api/snapshot`（或等价 state）。

---

## 示例

```bash
# 快照（无 token）
curl -s http://127.0.0.1:<PORT>/api/snapshot | head -c 500

# 带 token
curl -s -H "Authorization: Bearer $GRID_AUTH_TOKEN" \
  http://127.0.0.1:<PORT>/api/snapshot

# RISEx restart（closeFirst 必须 body）
curl -s -X POST http://127.0.0.1:<PORT>/api/fleet/restart \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GRID_AUTH_TOKEN" \
  -d '{"closeFirst":false}'
```

---

## 运维脚本

见 `deploy/grid-monitor.js`：通过环境变量 `EXTENDED_GRID_URL`、`RISEX_GRID_URL`、`DEC_GRID_URL` 轮询各所 `/api/snapshot`。

---

## 相关文档

- 舰队语义：[STRATEGY.md](./STRATEGY.md)
- 勿并行 restart：[PITFALLS.md](./PITFALLS.md)
