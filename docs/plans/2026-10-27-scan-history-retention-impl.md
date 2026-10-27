# 扫描记录保留 30 天

## 范围与口径

- 后端分支：`codex/scan-history-retention`；循势前端分支：`feature/recent-scan-history`。
- 用户明确要求服务端自动清理超过 30 天的扫描记录。按信号/扫描查询日期计算，使用上海日期，含今天共 30 个自然日，不按任务创建时间或交易日数量计算。例如 2026-10-27 保留 2026-09-28 至 2026-10-27。
- 删除过期 `stock_signal_scan_runs` 的 done/failed 任务，以及过期 `stock_signals` 中 B（`value='1'`）、空值和其他非 S 缓存；指定代码扫描产生的过期非 S 缓存同样清理。
- `value='0'` 的历史 S 事件独立保留，解除其过期 run_id 关联。它们是原观察池历史判定的依据，不再作为可查询的过期扫描结果；不删除观察池条目，不重置已触发状态。

## 执行方式

`StockScanRetentionService` 在应用 bootstrap 执行一次，晚于 `StockSignalsService.onModuleInit` 对遗留任务的恢复；之后每天上海时间 00:10 执行。沿用应用已有全局 ScheduleModule，不另建调度器，不增加配置或依赖。

一轮清理在同一数据库事务内完成：查询过期 pending/running 的日期，整个日期的数据均跳过；解除可清理日期历史 S 的 run_id；删除非 S 缓存；删除终态任务。进行中任务结束后由下一轮清理。服务内重入保护和 Cron waitForCompletion 防止单实例重复执行；当前部署仍是单实例，多副本需要分布式锁。

失败由事务回滚并记录日志，不阻止应用启动；下一轮重试。日志只记录日期边界、数量及错误，不记录用户标识。

## 查询与写入契约

- GET `/stock-signals/dates` 使用数据库 BETWEEN 限制在窗口内，仍每日期取最新 done。
- GET `/stock-signals?date=...` 对过期日期直接 404，不依赖清理任务是否成功。
- GET `/stock-signals/scans/:id` 对过期终态任务返回 404；进行中任务仍可查看进度。
- POST `/stock-signals/scans` 与系统 `ensureMarketRun` 拒绝窗口外日期（400），禁止清理后又生成旧扫描。原真实日期、未来日期及周末规则保留。
- `refreshWatchlistHistory` 仍可写入旧 S 事件，保证观察池历史逻辑不受缓存保留期影响。
- 前端日历禁用窗口外日期，过期书签归一到近期最新日期/今天；历史列表保持近 30 天过滤。

## 文件

- `src/stock-signals/scan-history-window.ts`：窗口与上海日期。
- `stock-scan-retention.service.ts`、`stock-signals.module.ts`：事务清理及调度注册。
- `stock-signals.service.ts`、`stock-signals.controller.ts`：读写窗口与接口文档。
- `test/stock-signals/stock-scan-retention.spec.ts`：边界、启动、事务失败/重试、重入、进行中日期保护、S 事件保留及注册。
- `test/stock-signals/stock-signals.service.spec.ts`：窗口首末、过期查询/扫描、历史查询条件及任务进度。

## 验证与发布

专项测试 33 项、全量 Jest（70 套件、774 项）、lint、TypeScript 检查与构建全部通过；前端测试（7 项）、lint、构建与完整浏览器回归通过，含窗口边界、过期日期书签、排序、扫描恢复、观察池及行情轮询。两仓库 `git diff --check` 通过。所有测试使用替代仓库与数据源，不连接真实数据库。没有部署，没有运行生产清理。

无数据库迁移、DDL、配置或新增依赖。前端窗口限制可独立发布；发布后端后首次启动会实际清理已有过期扫描及缓存，应在正常数据库备份策略下发布。

回滚代码可停止后续清理，但不能恢复已经删除的记录；需要从数据库备份恢复。S 历史与观察池没有纳入删除范围。
