# Contributing

感谢考虑为本项目贡献。本仓库为**实盘网格控制面参考实现**，欢迎修 bug、补文档、改进适配器。

## 开始之前

1. 阅读 [SETUP.md](docs/SETUP.md) 与 [PITFALLS.md](docs/PITFALLS.md)
2. Fork → 分支 → PR；保持 PR 范围聚焦（一个 PR 解决一类问题）

## 请勿提交

- `.env`、私钥、token、真实 IP/域名
- 仅格式化、与 PR 无关的大规模重排
- 未经讨论的破坏性策略参数变更（会影响所有 Fork 者）

## PR 检查清单

- [ ] 未包含敏感信息（`git diff` 已人工看过）
- [ ] 文档与行为一致（改 API 请同步 [docs/API.md](docs/API.md)）
- [ ] Decibel/Overview 改动可跑 `npm run typecheck`（在对应 app 目录）
- [ ] 中文注释/文档与现有风格一致

## 代码风格

- 沿用现有命名与目录结构，勿引入无关抽象
- 注释只写非显而易见的业务/链上细节
- Extended/RISEx 为 Node ESM；Decibel/Overview 为 TypeScript

## Issue

好 Issue 包含：所（Extended/RISEx/Decibel/Overview）、复现步骤、期望 vs 实际、相关日志（**打码密钥**）。

## License

贡献即表示同意以 [MIT License](./LICENSE) 授权。
