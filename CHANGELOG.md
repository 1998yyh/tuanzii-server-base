# 变更记录

## 2026-10-28 — 整合小肥鱼日记后台

- 分支：`feat/xiaofeiyu-diary`，基于main；使用同仓库隔离工作目录，原工作区未提交的媒体改动保留。
- 背景与目标：日记后台统一纳入tuanzi-server-base，不另建后台仓库，遵守Nest/TypeORM/MySQL/JWT和现有开发规范。
- 变更及文件：新增 `src/xiaofeiyu-diary/`、镜像 `test/xiaofeiyu-diary/`；AppModule注册；手写 `docs/plans/2026-10-28-xiaofeiyu-diary.sql`；可选密钥写入.env.example；显式离线导入脚本位于scripts；tsconfig.build限定src以维持Docker入口；README、CLAUDE及实现文档同步。
- 影响范围：管理员共享摘要阅读/搜索/分页/已读、本机Webhook接收。复用现有JWT与MySQL，不修改JWT有效期、CORS、synchronize或其他业务。
- 实际验证：lint、typecheck、build、脚本eslint及完整73套件/813项Jest通过（新增39项）；确认dist/main.js存在、离线scripts不进入dist。数据库和HTTP外部依赖均为替身。未执行真实MySQL DDL/导入、Docker/Nginx联调或生产操作。
- 兼容性与迁移：旧整数ID改UUID，列表切换标准page/limit，前端需配套PR；旧Cookie会话不迁移。旧SQLite仅通过默认只读、显式--apply脚本导入，保留原库；无自动导入。
- 风险与回退：Webhook无消息去重，私网直连仍必须密钥，公网及所有API别名需阻断内部入口；MySQL和线上路由需发布验收。回退保留新表和旧备份，不自动倒退DDL/数据；前后端版本须协调。
- 交付：功能分支和PR，未合并main，未触发部署、未修改生产推送或数据。[后台 PR #17](https://github.com/1998yyh/tuanzii-server-base/pull/17) 与 [配套前端 PR #3](https://github.com/1998yyh/xiaofeiyu-diary/pull/3) 已创建。隔离SQLite夹具通过导入CLI的默认只读检查，未连接MySQL；额外覆盖共享5mb解析上限下日记256KiB限制。具体实现与后续操作见同日实现文档。
