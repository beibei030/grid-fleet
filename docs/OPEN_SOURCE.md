# 开源说明 · Multi-Venue Neutral Grid Fleet

> 本文档用**表格**说明本仓库「是什么 / 不是什么」，内容来自作者 VPS 实盘代码整理，供 Fork 与二次开发参考。  
> **不构成投资建议**；实盘盈亏、强平、API 限流等风险由使用者自行承担。

![架构概览](./assets/grid-fleet-overview.png)

---

## 1. 一句话

| 项目 | 说明 |
|------|------|
| **名称** | Multi-Venue Neutral Grid Fleet（多所永续中性网格舰队） |
| **定位** | 作者在 **Extended / RISEx / Decibel** 三所实盘使用的网格**控制面**开源版 |
| **形态** | 4 个独立 Node/TS 进程 + HTTP/SSE 看板 + 只读总看板 |
| **策略** | 中性网格：区间内对敲赚格差，破界移框，库存超限刹车 |
| **代码规模** | 约 **116** 个 tracked 文件（三所适配 + 舰队维护 + 文档） |
| **仓库** | https://github.com/beibei030/grid-fleet （Public） |

---

## 2. 这是什么 / 不是什么

| ✅ 这是 | ❌ 这不是 |
|---------|-----------|
| 与作者生产环境**策略参数、舰队维护逻辑对齐**的可运行代码 | 保证盈利的「印钞机」或带单信号 |
| 三所完整适配器 + 看板 + 运维踩坑文档 | 你的 API 密钥、私钥、VPS、代理节点 |
| 填好 `.env`、自备交易所账户后可本地/VPS 部署 | 一键托管 SaaS；作者不提供代操实盘 |
| Issue/PR 友好的参考实现 | Ondo / 第四所网格（作者私有环境另有完整版） |
| 真实踩坑总结（429、reduce-only、Decibel 索引延迟等） | 隐藏核心逻辑的「假开源壳子」 |

---

## 3. 仓库结构

| 目录 | 交易所 | 技术栈 | 主要职责 |
|------|--------|--------|----------|
| `apps/extended-grid` | [Extended](https://app.extended.exchange/join/AIQIANG888) | Node ESM，零 npm 运行时依赖 | Stark 永续网格、舰队 seed/rotate/maintain、SSE 看板 |
| `apps/risex-grid` | [RISEx](https://developer.rise.trade/) | Node ESM + 链上 Signer | 链上写操作队列、429 退避、3 槽舰队 |
| `apps/decibel-grid` | [Decibel](https://app.decibel.trade/r/K7B2QM) | TypeScript + Aptos / Decibel SDK | 链上 PostOnly 网格、Gas Station、独立 grid 进程 |
| `apps/overview` | 聚合上列三所 | TypeScript | 只读总看板、跨所 snapshot、可选 Telegram digest |
| `docs/` | — | Markdown | SETUP / STRATEGY / PITFALLS / 本文 |
| `deploy/` | — | Node 脚本 | 健康巡检、`grid-monitor`（URL 走环境变量） |

---

## 4. 架构（进程关系）

```
                    ┌─────────────────┐
                    │  apps/overview  │  只读聚合
                    │   (总看板)       │
                    └────────┬────────┘
           HTTP snapshot    │    HTTP snapshot
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
  apps/extended-grid  apps/risex-grid   apps/decibel-grid
     Extended 永续        RISEx 链上         Decibel Aptos
```

| 原则 | 说明 |
|------|------|
| **进程隔离** | 每所单独进程、单独 `.env`，互不影响 |
| **看板可独立** | 可只跑一所 grid，不必强依赖 Overview |
| **Overview 不下单** | 总看板仅拉各所 `/api/snapshot`，无交易权限 |
| **认证可选** | `GRID_AUTH_TOKEN` 非空时，看板与 API 需 Bearer |

---

## 5. 策略参数（三所对照 · 与生产一致）

| 参数 | Extended | RISEx | Decibel | 含义 |
|------|----------|-------|---------|------|
| 模式 | neutral | neutral | neutral | 现价下方 buy、上方 sell |
| 槽位 | 3 | 3 | 3 | 默认 BTC / ETH / SOL |
| 格数 `gridCount` | 24 | 18 | 22 | 区间内挂单密度 |
| 半宽 `rangeHalfPct` | 0.024 | 0.024 | 0.024 | 现价 ± **2.4%** |
| 杠杆 | 5x | 5x | 5x | 各所 fleet 默认 |
| `skipBand` | 0.10 | 0.10 | 0.10 | 中心附近跳过铺单比例 |
| 破区间 | `shiftGrid` / `autoRecenter` | 同左 | 同左 | **移框重挂，默认不平仓** |
| 库存上限 | `maxInventoryMult = 4` | 同左 | 同左 | 净仓超 4×格 size 停同向加仓 |
| 平仓侧覆盖 | reduce-only ≈ **70%** 持仓 | 同左 | 同左 | 去库存，非趋势止损 |
| 挂单偏少 | `replenishIfEmpty` | 同左 | 同左 | **只补格，不整盘 recenter** |
| 空槽恢复 | `fleet-autostart` | 同左（满 3 槽才 skip） | 同左 | 补 bot / seed |

> 详细规则见 [STRATEGY.md](./STRATEGY.md)

---

## 6. 各所凭证与运行要求

| 所 | 必填环境变量 | 注册 / 文档 | 运行命令 | 特别说明 |
|----|--------------|-------------|----------|----------|
| **Extended** | `EXTENDED_API_KEY`, `EXTENDED_VAULT`, `EXTENDED_STARK_PRIVATE_KEY`, `EXTENDED_STARK_PUBLIC_KEY`, `PORT` | [邀请注册](https://app.extended.exchange/join/AIQIANG888) · [API 文档](https://api.docs.extended.exchange/) | `node server.js` | 国内常需 `HTTPS_PROXY`；下单异步需 poll |
| **RISEx** | `RISEX_ACCOUNT`, `RISEX_SIGNER_KEY`, `PORT` | [rise.trade](https://rise.trade) Settings → API Signer · [集成文档](https://developer.rise.trade/reference/integration) | `node server.js` | **tx quota** 限速；勿并行多个 restart |
| **Decibel** | `DECIBEL_API_KEY`, `DECIBEL_ACCOUNT_PRIVATE_KEY`, `DEC_GRID_PORT` | [邀请注册](https://app.decibel.trade/r/K7B2QM) · [Write SDK](https://docs.decibel.trade/typescript-sdk/write-sdk) | `npm i && npm run start` | Geomi Node Key + Aptos 私钥；Gas Station 可选 |
| **Overview** | `OVERVIEW_PORT`, `*_GRID_FLEET_URL` ×3 | — | `npm i && npm run start` | **三所 grid 先启动** |

完整逐步说明 → [SETUP.md](./SETUP.md)

---

## 7. 内置能力清单（代码里真实存在）

| 能力 | Extended | RISEx | Decibel | Overview |
|------|:--------:|:-----:|:-------:|:--------:|
| 中性网格 seed / 成交补格 | ✅ | ✅ | ✅ | — |
| 破界移框 `shiftGrid` | ✅ | ✅ | ✅ | — |
| 偏少补铺 `replenishIfEmpty` | ✅ | ✅ | ✅ | — |
| 库存刹车 + reduce-only 去库存 | ✅ | ✅ | ✅ | — |
| 舰队 rotate / autostart / maintain | ✅ | ✅ | ✅ | — |
| HTTP API + Web 看板 | ✅ | ✅ | ✅ | ✅ |
| SSE / snapshot 聚合 | ✅ | ✅ | ✅ | ✅ |
| 429 / 链上限速退避 | — | ✅ | 部分 | — |
| 可选 Bearer 认证 | ✅ | ✅ | ✅ | ✅ |
| Telegram 日报 / 告警 | — | — | — | 可选 |

---

## 8. 推荐启动顺序

| 步骤 | 操作 | 验证 |
|------|------|------|
| 1 | `cd apps/extended-grid` → `cp .env.example .env` → 填密钥 → `node server.js` | 浏览器打开 `http://127.0.0.1:<PORT>` |
| 2 | `cd apps/risex-grid` → 同上 → `node server.js` | 看板有 bot / open orders |
| 3 | `cd apps/decibel-grid` → `npm i` → 填 `.env` → `npm run start` | 日志出现 `[Decibel] 已连接` |
| 4 | `cd apps/overview` → 填三个 `*_GRID_FLEET_URL` → `npm run start` | 总看板显示三所快照 |
| 5（可选） | `node deploy/grid-monitor.js` | 巡检脚本无 ERROR |

---

## 9. 文档索引

| 文档 | 适合谁读 | 内容 |
|------|----------|------|
| [README.md](../README.md) | 所有人 | 快速开始、架构、链接 |
| [SETUP.md](./SETUP.md) | 要跑实盘的人 | API 怎么拿、`.env` 怎么填、Decibel 逐步 |
| [STRATEGY.md](./STRATEGY.md) | 要理解策略的人 | 参数、铺单规则、舰队维护 |
| [PITFALLS.md](./PITFALLS.md) | 运维 / 踩坑 | 429、reduce-only、索引延迟、勿并行 restart |
| **OPEN_SOURCE.md**（本文） | 开源访客 | 真实边界、对照表、不是什么 |

---

## 10. 实盘风险与策略边界

| 风险 / 边界 | 说明 |
|-------------|------|
| **趋势市** | 移框可延续运行，但库存与手续费压力上升；**不保证**正收益 |
| **不会自动市价全平** | 除非显式配置；极端情况依赖交易所强平规则 |
| **参数非万能** | ±2.4%、5x、22 格等为作者环境调优，他人需自行评估 |
| **运维门槛** | RISEx quota、Decibel 链上延迟、Extended 代理——见 PITFALLS |
| **密钥安全** | 切勿 commit `.env`；公网暴露请开 `GRID_AUTH_TOKEN` |
| **法律与合规** | 使用者自行确认当地法规与交易所 ToS |

---

## 11. Fork 后能做什么

| 场景 | 是否可行 | 备注 |
|------|:--------:|------|
| 只跑一所（如仅 Decibel） | ✅ | 不启 Overview 即可 |
| 改格数 / 区间 / 杠杆 | ✅ | 改 fleet-plan 或 `.env` |
| 对接自己的监控 | ✅ | 消费各所 `/api/snapshot` |
| 学习多所网格工程结构 | ✅ | 三所适配器可对照阅读 |
| 不注册交易所直接「模拟赚钱」 | ❌ | 无凭证无法下单；Decibel 有 paper 模式需自行配置 |
| 期望作者代运维或保证收益 | ❌ | 开源仅为代码与文档 |

---

## 12. 贡献

| 欢迎 | 请勿 |
|------|------|
| Bug 修复、文档改进、适配 PR | PR 中含 `.env`、私钥、真实地址 |
| Issue 描述复现步骤与日志 | 在 Issue 中粘贴完整 API Key |

---

**License / 免责声明**：本仓库为策略与控制面参考代码，**不构成投资建议**。作者不对任何使用者的资金损失负责。
