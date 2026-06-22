# Security Policy

## 支持的版本

| 版本 | 支持 |
|------|------|
| `main` 最新 | ✅ |
| 旧 tag | 仅安全修复按需 |

## 请勿提交的内容

以下信息**永远不要**进入 git（含 Issue、PR、截图）：

- `.env`、`.env.local` 及任何含真实密钥的文件
- API Key、Stark 私钥、Aptos 私钥、Signer 私钥
- `GRID_AUTH_TOKEN` / `HEDGE_AUTH_TOKEN` 的真实值
- VPS IP、SSH 私钥、内网地址、代理节点 URL
- 钱包地址、子账户地址（若不想公开）
- Telegram Bot Token、Chat ID

本仓库 `.gitignore` 已排除常见敏感路径；**提交前请自行 `git diff` 检查**。

## 本地运行建议

1. 仅在本机或自有 VPS 运行；公网暴露时务必设置 `GRID_AUTH_TOKEN`
2. 使用 HTTPS 反向代理 + 防火墙限制来源 IP（自行配置）
3. 各所 API 权限按最小需要开通（仅交易/读，勿给提现权限若交易所支持细分）
4. 定期轮换 API Key；怀疑泄露立即在交易所吊销

## 报告安全问题

若在本仓库发现**代码层面**的安全漏洞（例如鉴权绕过、路径注入），请：

1. **不要**公开 Issue 贴 exploit 细节
2. 通过 GitHub **Private vulnerability report**（若仓库已开启）或仓库 Owner 私信说明复现步骤

我们不会奖励 bounty；会在确认后修复并致谢（若你愿意署名）。

## 免责声明

本软件按「原样」提供。作者不对因误配置密钥、公网裸奔、或交易所侧风险导致的资金损失负责。
