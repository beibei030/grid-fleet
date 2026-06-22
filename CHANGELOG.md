# Changelog

本仓库遵循 [语义化版本](https://semver.org/lang/zh-CN/)。**不含**任何账户、密钥或服务器信息变更记录。

## [1.0.0] - 2026-06-22

### Added

- 三所永续中性网格：`extended-grid`、`risex-grid`、`decibel-grid`
- 只读总看板 `overview`（聚合三所 snapshot）
- 文档：`SETUP`、`STRATEGY`、`PITFALLS`、`OPEN_SOURCE`、`API`
- Mac/Linux 脚本：`scripts/install-all.sh`、`scripts/start-*.sh`
- 部署巡检：`deploy/grid-monitor.js`、`deploy/ensure-grid-health.js`
- 架构概览图与示例界面截图（演示数据，非实盘）

### Notes

- 策略参数与作者生产环境对齐（±2.4%、3 槽、舰队维护逻辑）
- 不包含 Ondo 第四所（作者私有环境另有完整版）
- 使用前请阅读 [SECURITY.md](./SECURITY.md)

## [0.1.0] - 2026-06-22

- 初始公开提交（三所 + Overview + 基础文档）

[1.0.0]: https://github.com/beibei030/grid-fleet/releases/tag/v1.0.0
[0.1.0]: https://github.com/beibei030/grid-fleet/commit/5ff9d14
