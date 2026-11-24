# NOTICE

本仓库包含来自第三方开源项目的代码：

## dsh-trading

- 来源：https://github.com/zhu1090093659/dsh-trading
- 版本：v0.7.1（tag `v0.7.1`，client 源码 22,544 行）
- 许可：PolyForm Noncommercial License 1.0.0（见 `LICENSE.upstream`）
- 使用范围：`src/trading/`（客户端组件、样式、locale、图标、指标适配）、`cordis.patch.yml` 中 55 行上游 bundle patch
- 修改：改为 `main` 面板壳、移除 shell.overlay 栅格接管、新增分时图与盯盘报告面板、移除加密货币与下单台、列宽可拖拽

## 运行时依赖

`@dshtrading/*` 各包、`lightweight-charts`、`undici`、`react` 等由 npm 分发，遵循各自许可。
行情数据版权归腾讯、Yahoo、同花顺、金十、Polymarket 等数据源所有，本项目仅本地展示，不再分发。
