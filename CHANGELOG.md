# 变更记录

## 2026-10-28 — 后台获准自动发布与只读核对

- 背景：初始交付未执行合并或部署；随后GitHub账号1998yyh合并PR #17，main触发自动发布。发现后向用户确认，用户明确选择“允许这次自动部署继续”。
- 实际结果：[发布运行40653906640](https://github.com/1998yyh/tuanzii-server-base/actions/runs/40653906640) 成功，对应main提交24ad12b。原流水线完成DDL、构建重启与健康检查；未手动上传源码或启动第二套日记服务。
- 验证：仅只读检查宿主机受保护日记接口返回401，MySQL新表六个字段符合设计；未读取或输出日记正文，未导入旧SQLite、未发送测试推送。独立前端入口仍为404，未部署前端。
- 当前限制：XIAOFEIYU_WEBHOOK_KEY尚未配置，Webhook保持关闭；不自动修改ENV_PRODUCTION或插件配置。后续接入推送需单独配置。
- 文档：本条、README与实现说明补充实际发布结果，覆盖下方初始交付时“未部署/未执行DDL”的阶段状态；不改变代码、表结构或运行配置。文档补充通过PR交付，不触发第二次发布。
- 回退：沿用现有GitHub流程，保留新表和旧备份；不自动倒退DDL或恢复数据。

## 2026-10-28 — 整合小肥鱼日记后台

- 分支：`feat/xiaofeiyu-diary`，基于main；使用同仓库隔离工作目录，原工作区未提交的媒体改动保留。
- 背景与目标：日记后台统一纳入tuanzi-server-base，不另建后台仓库，遵守Nest/TypeORM/MySQL/JWT和现有开发规范。
- 变更及文件：新增 `src/xiaofeiyu-diary/`、镜像 `test/xiaofeiyu-diary/`；AppModule注册；手写 `docs/plans/2026-10-28-xiaofeiyu-diary.sql`；可选密钥写入.env.example；显式离线导入脚本位于scripts；tsconfig.build限定src以维持Docker入口；README、CLAUDE及实现文档同步。
- 影响范围：管理员共享摘要阅读/搜索/分页/已读、本机Webhook接收。复用现有JWT与MySQL，不修改JWT有效期、CORS、synchronize或其他业务。
- 实际验证：lint、typecheck、build、脚本eslint及完整73套件/813项Jest通过（新增39项）；确认dist/main.js存在、离线scripts不进入dist。数据库和HTTP外部依赖均为替身。未执行真实MySQL DDL/导入、Docker/Nginx联调或生产操作。
- 兼容性与迁移：旧整数ID改UUID，列表切换标准page/limit，前端需配套PR；旧Cookie会话不迁移。旧SQLite仅通过默认只读、显式--apply脚本导入，保留原库；无自动导入。
- 风险与回退：Webhook无消息去重，私网直连仍必须密钥，公网及所有API别名需阻断内部入口；MySQL和线上路由需发布验收。回退保留新表和旧备份，不自动倒退DDL/数据；前后端版本须协调。
- 交付：功能分支和PR，未合并main，未触发部署、未修改生产推送或数据。[后台 PR #17](https://github.com/1998yyh/tuanzii-server-base/pull/17) 与 [配套前端 PR #3](https://github.com/1998yyh/xiaofeiyu-diary/pull/3) 已创建。隔离SQLite夹具通过导入CLI的默认只读检查，未连接MySQL；额外覆盖共享5mb解析上限下日记256KiB限制。具体实现与后续操作见同日实现文档。
