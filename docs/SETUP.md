# 环境与 API 配置指南

本仓库目标是：**按文档填好 `.env`、启动各进程后，即可达到与作者相同的网格维护水平**（策略参数、舰队维护、看板聚合均已内置）。

---

## 注册与邀请（可选）

| 所 | 链接 |
|----|------|
| **Extended** | https://app.extended.exchange/join/AIQIANG888 |
| **Decibel** | https://app.decibel.trade/r/K7B2QM |
| RISEx | https://rise.trade （Settings → API Keys 创建 Signer） |

---

## 通用约定

1. **每个所独立进程、独立 `.env`**，互不覆盖。
2. **`GRID_AUTH_TOKEN`**（可选）：非空时，看板与 `/api/*` 需 `Authorization: Bearer <token>`。VPS 暴露公网时建议开启。
3. **`MODE=mainnet`**：Decibel 实盘；Extended / RISEx 默认即主网。
4. **总看板**通过 `*_GRID_FLEET_URL` 指向各所本机 HTTP 地址（与各所 `PORT` 一致）。

---

## Extended

### 获取凭证

1. 打开 [Extended](https://app.extended.exchange/join/AIQIANG888) 注册并入金。
2. 进入 **API Management**，创建 API Key。
3. 记录：**API Key**、**Vault ID**、**Stark Private Key**（及对应的 Public Key，若页面提供）。

### `.env` 示例

```env
PORT=
GRID_AUTH_TOKEN=

EXTENDED_API_KEY=
EXTENDED_VAULT=
EXTENDED_STARK_PRIVATE_KEY=
EXTENDED_STARK_PUBLIC_KEY=

# 国内部分网络需代理才能访问 Extended REST
# HTTPS_PROXY=http://127.0.0.1:你的代理端口
```

### 启动

```bash
cd apps/extended-grid
cp .env.example .env
# 编辑 .env 后
node server.js
```

浏览器打开看板：`http://127.0.0.1:<PORT>`（与 `.env` 中 `PORT` 一致）。

### 注意

- Extended 下单为**异步**，程序已内置 poll + tracked order，无需手改。
- 无持仓时不会下 reduce-only（避免 `Position is missing for reduce-only`）。

---

## RISEx

### 获取凭证

1. 在 [rise.trade](https://rise.trade) 连接钱包并入金。
2. **Settings → API Keys** 创建 **API Signer**。
3. 填入：
   - `RISEX_ACCOUNT`：主账户地址（0x…）
   - `RISEX_SIGNER_KEY`：Signer 私钥（0x…）

### `.env` 示例

```env
PORT=
GRID_AUTH_TOKEN=

RISEX_ACCOUNT=
RISEX_SIGNER_KEY=
RISEX_API_URL=https://api.rise.trade
RISEX_WS_URL=wss://ws.rise.trade/ws
RISE_ACTIVE_SLOTS=3
```

### 启动

```bash
cd apps/risex-grid
cp .env.example .env
node server.js
```

### 关于链上写操作限速（重要）

RISEx **没有固定的「每 10 秒 1 笔」常量**。账户有 **tx quota**，超限返回 `429` / `tx quota exceeded`。

本库内置**串行队列 + 429 退避**，正常单进程维护即可铺满网格。

**真正导致「永远铺不满」的常见原因（运维侧）：**

- 同时跑多个 `fleet/restart`、`autostart`、后台 fix 脚本 → 无意义 cancel/place 风暴，快速耗尽 quota
- 重启后 `cancelAll` 再全量重铺，而链上已有单本可承接
- SSH 长连等待铺单，中途又触发第二次 restart

**正确做法：** 单进程 + 看 `/api/snapshot` 轮询进度；偏少走 replenish，满铺需要时间时耐心等待队列消化 429。

---

## Decibel（重点）

Decibel 在 **Aptos 链上**，凭证比其他所多一步，但按下面做即可一次配通。

### 获取凭证

1. 打开 [Decibel](https://app.decibel.trade/r/K7B2QM) 注册，用钱包登录。
2. **Geomi Node API Key**（即 `DECIBEL_API_KEY`）  
   - 在 Decibel / Aptos 开发者入口申请 [Geomi](https://geomi.dev) 或文档中的 Node API Key。  
   - 用于 `DecibelReadDex` / `DecibelWriteDex` 的 `nodeApiKey`。
3. **Aptos 私钥**（`DECIBEL_ACCOUNT_PRIVATE_KEY`）  
   - 签名链上订单的 Ed25519 私钥。  
   - 支持 `0x…` 或 AIP-80 格式 `ed25519-priv-0x…`（推荐原样粘贴，避免格式警告）。
4. **子账户**（`DECIBEL_SUBACCOUNT`，**通常可留空**）  
   - 留空时 SDK 自动用 `getPrimarySubaccountAddr` 解析主交易子账户。  
   - 仅当你在 Decibel 使用**非默认子账户**时，才填链上 subaccount 地址。
5. **Gas Station**（`DECIBEL_GAS_STATION_API_KEY`，**可选**）  
   - 若不想钱包里备 APT 付 gas，可在 Geomi 开通 Gas Station，填入此项。  
   - 开启后写路径会 `skipSimulate` 以减少模拟失败。

### `.env` 示例

```env
DEC_GRID_PORT=
GRID_AUTH_TOKEN=

DECIBEL_API_KEY=
DECIBEL_ACCOUNT_PRIVATE_KEY=
DECIBEL_SUBACCOUNT=
DECIBEL_GAS_STATION_API_KEY=

DEC_GRID_STANDALONE=true
DEC_GRID_ENABLED=true
DEC_GRID_AUTOSTART=false

MODE=mainnet
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `DECIBEL_API_KEY` | 是 | Geomi Node API Key |
| `DECIBEL_ACCOUNT_PRIVATE_KEY` | 是 | Aptos Ed25519 私钥 |
| `DECIBEL_SUBACCOUNT` | 否 | 非默认子账户时填写 |
| `DECIBEL_GAS_STATION_API_KEY` | 否 | 代付 gas，无 APT 时使用 |
| `DEC_GRID_AUTOSTART` | 否 | `false` = 仅开看板，需手动点「启动」才交易 |

### 启动

```bash
cd apps/decibel-grid
npm install
cp .env.example .env
# 编辑 .env 后
npm run start
```

启动日志应出现类似：`[Decibel] 已连接 | API钱包… | 子账户 … | N 个市场 | gas:…`

### 注意

- **open 订单索引有延迟**（约数秒～十余秒）：程序已做空列表重试，勿因短时 0 单就反复 restart。
- **挂单偏少**走 `replenishIfEmpty`，不会因偏少整盘 recenter。
- `clientOrderId` 与 `orderId` 不一致时已做 remap。

---

## 总看板（Overview）

聚合三所 grid 进程的只读快照。

### `.env` 示例

```env
OVERVIEW_PORT=
GRID_AUTH_TOKEN=

GRID_FLEET_URL=http://127.0.0.1:<Extended 的 PORT>
RISEX_GRID_FLEET_URL=http://127.0.0.1:<RISEx 的 PORT>
DEC_GRID_FLEET_URL=http://127.0.0.1:<Decibel 的 PORT>

DEC_GRID_STANDALONE=true
```

### 启动

先启动三所 grid，再：

```bash
cd apps/overview
npm install
cp .env.example .env
npm run start
```

打开 `http://127.0.0.1:<OVERVIEW_PORT>`。

---

## 健康巡检（可选）

```bash
export GRID_AUTH_TOKEN=你的token   # 若各所启用了认证
export EXTENDED_GRID_URL=http://127.0.0.1:<ext端口>
export RISEX_GRID_URL=http://127.0.0.1:<risex端口>
export DEC_GRID_URL=http://127.0.0.1:<dec端口>
node deploy/grid-monitor.js
```

详见 `deploy/ensure-grid-health.js` 注释。

---

## 推荐启动顺序

1. Extended grid  
2. RISEx grid  
3. Decibel grid  
4. Overview  

各所看板可单独使用；Overview 仅聚合展示，不下单。
