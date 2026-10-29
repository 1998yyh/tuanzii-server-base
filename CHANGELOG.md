# 变更记录

## 2026-10-29 — 补齐评论成功报备通知过滤

- 分支：`fix/diary-comment-notices`；基于origin/main，临时worktree隔离开发，原目录未提交媒体改动保留。
- 背景与目标：用户发现「分享评论报备」仍进入日记。首版仅按「分享前评论检查」过滤，漏掉插件comment.mjs在评论发送成功后产生的「分享评论报备」「自主发言报备」两个固定标题。
- 具体变更及文件：日记Service用集中标题名单过滤三类评论流程通知；reason沿用“标题+通知不写入日记”，原检查标题响应兼容。Webhook Swagger、README、CLAUDE和实现说明同步；Service/HTTP逐标题回归覆盖空白、认证、DTO、非空正文、不入库及普通日记/待审回复不误伤。
- 影响范围：仅评论流程通知的日记入库，保留DSH检查、暂缓、分享与自主评论动作；无插件、密钥、数据库结构或其他模块变更。按用户截图的标题、时间及报备标识精确定位并删除1条历史报备，未清理其他日记。
- 验证方式与实际结果：日记模块3套件/61项、全量73套件/835项Jest及lint/typecheck/build/git diff --check通过；测试使用Mock Repository与隔离HTTP。历史截图条目已在事务中精确删除并核对不存在。部署验收结果见本任务PR及GitHub Actions记录。
- 兼容性与迁移：无依赖、环境、实体、DDL或前端运行代码变化。名单精确匹配、不按正文或模糊“报备”过滤；未列入名单的待审回复保持原行为。
- 风险与回退方式：插件新增或更名通知标题时需同步核对分类，不能假定所有notify都是日记；撤销本次新增名单项并通过GitHub Actions发布即可恢复报备入库，不补写已忽略消息。代码经PR合入main后自动部署，记录提交时尚未发布；合成通知验收必须先用禁止写入的替身Repository验证部署代码，再调用Webhook，以免旧版本产生测试日记。临时worktree和本地任务分支在合并后清理。

## 2026-10-29 — 分享前评论检查通知不进入日记

- 分支：`feat/diary-notice-filter`；基于origin/main，在临时worktree开发，原工作区未提交媒体改动保留。
- 背景与目标：DSH将评论检查的暂缓通知通过日记共用Webhook投递，用户要求保留检查、仅阻止此类系统通知进入日记。
- 具体变更及文件：日记Service在正文有效后按trim后的完整标题「分享前评论检查」过滤，不调用Repository创建/保存；Webhook Controller对忽略结果返回HTTP200及ok/ignored/reason，普通摘要保持HTTP201+ID。Service与HTTP测试覆盖不入库、空正文、相似标题/正文不误伤，以及认证/DTO和正常响应兼容；README、CLAUDE和原实现文档同步。
- 影响范围：仅未来同标题Webhook通知的入库处理；评论检查和暂缓决策继续在DSH执行。已有日记/通知、列表计数、已读状态、其他模块和配置不变，不修改生产数据或插件。
- 验证方式与实际结果：日记模块3套件/48项Jest、全量73套件/822项Jest、lint、typecheck、build与git diff --check均通过。PR #21合并后，[Actions 40830020475](https://github.com/1998yyh/tuanzii-server-base/actions/runs/40830020475)自动部署成功。先用已部署Service与禁止写入的替身Repository确认过滤，再以合成通知验收实际Webhook，返回200/ignored；该合成正文数据库计数前后均0。DSH检查仍开启，匿名日记API401、内部路径404，未读取或修改真实日记内容。
- 兼容性与迁移：无依赖、环境、实体或DDL变更，无数据迁移；插件对HTTP200正常视为推送成功，不需改Webhook地址或密钥。固定通知标题如在插件中改名，需同步调整过滤规则。
- 风险与回退方式：标题相同的自定义推送也会被忽略；保持精确匹配，避免误伤普通正文。撤销Service和Controller改动并通过原GitHub Actions发布即可恢复入库，不补写已忽略通知。用户要求后，PR #21已合入main的944f1c4并完成自动部署；前端仅文档PR #13同步协议。发布记录仅文档提交不重复部署；临时worktree和任务分支在本次文档合并后清理，原主目录未提交媒体改动保留。

## 2026-10-28 — 日记本取消管理员限制

- 分支：`feat/diary-member-access`，基于当前origin/main；继续使用同仓库隔离工作目录，保留原工作区媒体改动。
- 背景与目标：用户明确要求所有已登录账号可使用日记本，保留登录，不以admin角色限制。
- 变更及文件：日记Controller仅保留JwtAuthGuard，删除本模块AdminGuard和Module注册；Swagger说明、README、CLAUDE和实现文档同步。HTTP回归保留真实JwtStrategy，覆盖普通用户列表/单篇已读/全部已读，降级继续访问、账号删除及匿名写操作拒绝。
- 影响范围：仅小肥鱼日记；共享日记和已读状态语义保留，其他模块权限、Webhook私网/密钥、JWT有效期、CORS与synchronize不变。
- 验证：本地lint、typecheck、build及完整73套件/816项Jest通过；[后台Actions 40661018421](https://github.com/1998yyh/tuanzii-server-base/actions/runs/40661018421) 已成功；通过线上Controller元数据只读核对仅有JwtAuthGuard，无AdminGuard。未用真实账号读取日记或写已读。
- 兼容与迁移：无DDL、数据或账号迁移；前后端需配套发布。回退对应两端代码可恢复管理员限制，数据库无变化。
- 发布：[PR #19](https://github.com/1998yyh/tuanzii-server-base/pull/19) 已合并，main提交aeed868通过原GitHub流程发布成功，无新增DDL；配套前端PR #8已合并，正按前端工作流发布。

## 2026-10-28 — 整合小肥鱼日记后台

- 分支：`feat/xiaofeiyu-diary`，基于main；使用同仓库隔离工作目录，原工作区未提交的媒体改动保留。
- 背景与目标：日记后台统一纳入tuanzi-server-base，不另建后台仓库，遵守Nest/TypeORM/MySQL/JWT和现有开发规范。
- 变更及文件：新增 `src/xiaofeiyu-diary/`、镜像 `test/xiaofeiyu-diary/`；AppModule注册；手写 `docs/plans/2026-10-28-xiaofeiyu-diary.sql`；可选密钥写入.env.example；显式离线导入脚本位于scripts；tsconfig.build限定src以维持Docker入口；README、CLAUDE及实现文档同步。
- 影响范围：管理员共享摘要阅读/搜索/分页/已读、本机Webhook接收。复用现有JWT与MySQL，不修改JWT有效期、CORS、synchronize或其他业务。
- 实际验证：lint、typecheck、build、脚本eslint及完整73套件/813项Jest通过（新增39项）；确认dist/main.js存在、离线scripts不进入dist。数据库和HTTP外部依赖均为替身。未执行真实MySQL DDL/导入、Docker/Nginx联调或生产操作。
- 兼容性与迁移：旧整数ID改UUID，列表切换标准page/limit，前端需配套PR；旧Cookie会话不迁移。旧SQLite仅通过默认只读、显式--apply脚本导入，保留原库；无自动导入。
- 风险与回退：Webhook无消息去重，私网直连仍必须密钥，公网及所有API别名需阻断内部入口；MySQL和线上路由需发布验收。回退保留新表和旧备份，不自动倒退DDL/数据；前后端版本须协调。
- 交付：功能分支和PR，未合并main，未触发部署、未修改生产推送或数据。[后台 PR #17](https://github.com/1998yyh/tuanzii-server-base/pull/17) 与 [配套前端 PR #3](https://github.com/1998yyh/xiaofeiyu-diary/pull/3) 已创建。隔离SQLite夹具通过导入CLI的默认只读检查，未连接MySQL；额外覆盖共享5mb解析上限下日记256KiB限制。具体实现与后续操作见同日实现文档。
