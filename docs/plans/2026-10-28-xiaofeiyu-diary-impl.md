# 小肥鱼日记整合共享后台

## 目标与边界

按用户要求将原独立 Node HTTP/SQLite 日记后台移入 tuanzi-server-base。采用 NestJS Controller/Service/DTO/Guard、TypeORM 和 MySQL，复用现有 AuthModule/JwtStrategy；不新建后台仓库、进程或对外端口。前端仍为独立 Vue 项目。本任务只提交功能分支与 PR，不合并 main、不部署、不执行生产 SQL 或导入。

## 代码结构

`src/xiaofeiyu-diary/` 包含 entity、DTO、JWT认证与内部推送守卫、Service、读写 Controller、Webhook Controller、Module。AppModule 注册模块，ConfigModule 沿用全局配置。Controller 不接触 Repository，响应显式挑选字段，DTO 使用 Swagger 和 class-validator。

实体 `xiaofeiyu_diary_entries`：UUID id、title varchar(300)、content mediumtext、is_read、created_at/updated_at datetime(6)，索引 created_at/id 与 is_read/created_at。DDL 位于同日 SQL，synchronize 保持 false，原 ddl_history 自动执行流程不变。

`tsconfig.build.json` 将生产构建限定 src，避免 scripts 下的离线入口将输出挪到 dist/src/main；Docker 所需 dist/main.js 已检查。通用 typecheck 仍检查脚本和测试。

## 接口与身份

| 方法与路径 | 说明 | 权限 |
| --- | --- | --- |
| GET /api/xiaofeiyu/entries | q、unread=0/1、page、limit | 现有有效access JWT，所有用户 |
| POST /api/xiaofeiyu/entries/:uuid/read | 单篇已读，UUID Pipe | 同上 |
| POST /api/xiaofeiyu/entries/read-all | 全部已读 | 同上 |
| POST /api/internal/xiaofeiyu/webhook | 摘要持久化201回ID；检查通知忽略200 | 本机直连 + 独立密钥 |

列表返回 `{items,total,page,limit,totalPages,allTotal,unread,hasMore}`；total 为筛选后数量，allTotal/unread 为全局计数。条目 `{id,title,text,createdAt,read}`，按接收时间和ID倒序。搜索用参数化 LOCATE，百分号/下划线按字面量处理。分页默认30、最多100，页码从1开始，最多1000000。不提供并发插入时快照一致性。

所有登录用户均可访问，未登录/无效/refresh token 401；JwtStrategy每次读取当前用户，账号删除后原令牌失效。日记和已读状态由所有登录用户共享；不新增 userId 私有本。已读操作幂等，找不到404。前端复用原 login/profile，仅 sessionStorage 保存access token，过期重新登录；旧独立Cookie会话不迁移。

## Webhook

`XIAOFEIYU_WEBHOOK_KEY` 为可选配置，32–256字符；不合法时仅Webhook返回503，其他模块可正常启动。优先 `X-Xiaofeiyu-Key`，兼容 query key，恒定时间比较摘要。

读取原始 socket 地址，只允许回环/RFC1918/IPv6 ULA，兼容Docker桥接；拒绝存在 X-Forwarded-For、Forwarded、X-Real-IP 的请求，不信任其内容。宿主机3000继续仅绑定127.0.0.1。公网Nginx和其他应用的共享API别名应阻断内部路径，不允许清除转发头来放行推送。私网检查不能取代密钥。

请求字段 title/text/content/format；text优先，content备用；默认标题“小肥鱼的碎碎念”，移除正文重复标题。拒绝空正文、无效类型、未知字段；上限256KiB、标题300字、正文100000字。HTML/Markdown均作为普通文本存储，前端不执行HTML。数据库保存失败不返回成功。暂无消息ID去重，重复投递可能新增日记。日志不写密钥/正文；查询密钥仅用于不支持请求头的旧插件，不经公网代理。

2026-10-29补充系统通知过滤：DSH的评论检查通知通过与日记相同的notify/Webhook通道发送。标题trim后精确为「分享前评论检查」时，在私网、密钥、DTO与非空正文校验通过后，返回HTTP200及 `{ok:true,ignored:true,reason:"分享前评论检查通知不写入日记"}`，不调用Repository.create/save，也不产生ID。DSH将200视为投递成功，原评论检查、暂缓决策和本地评估记录继续保留；不修改插件或评论判断阈值。

仅按该固定通知标题过滤，正文提及该词或其他部分相似标题均正常保存；普通日记保持201及 `{ok:true,id}`。已有同类通知不会自动删除，列表、搜索和未读计数不改历史数据。无环境变量、依赖、实体、DDL或前端运行代码变更。回退过滤逻辑即可恢复该类通知入库，不补写被忽略的消息。

## 旧 SQLite 的显式导入

仅在后续获准发布时操作：先停止旧写入，保留原文件与 WAL 的一致备份，使用已备份快照；先在开发库验证 DDL/导入。旧会话不迁移。

在后台仓库根目录，使用支持 node:sqlite 的Node（22.13+；建议与前端一致的24），安装开发依赖：

```sh
pnpm exec ts-node scripts/import-xiaofeiyu-sqlite.ts --source /absolute/path/to/backup.sqlite3
```

默认只读校验所有记录，不连接MySQL。只有显式加入 --apply 才加载 `.env.local` / `.env`（现有process.env优先），使用标准DB_*项连接已有MySQL表；不会建表或修改SQLite：

```sh
pnpm exec ts-node scripts/import-xiaofeiyu-sqlite.ts --source /absolute/path/to/backup.sqlite3 --apply
```

标题、正文、接收时间与已读状态保留，updatedAt初始化为接收时间。旧整数ID映射为固定命名空间UUID，事务分批插入，重复ID跳过，不覆盖已更新的已读状态。脚本针对单一旧日记库，不可用于合并多个各自从1起号的SQLite库。只输出条数和脱敏失败信息，不输出日记、凭据或源路径。原库永久保持只读；实际MySQL导入和DDL尚未执行。

## 发布与回退

后台main沿用自动部署，PR未经明确发布授权不要合并。先经原DDL流程发布后台，GitHub ENV_PRODUCTION加入独立推送密钥，再发布前端静态站点，最后单独配置插件直连宿主机回环Webhook。前端不再创建systemd或管理SQLite。

旧服务保持停用，旧文件/撤下备份保留。回退后台代码保留新表，DDL不倒退，不自动恢复数据库。前端旧版本依赖独立服务，回退须协调API版本，不能直接重启旧服务混写数据。

## 验证与限制

本地 lint、typecheck、build、额外脚本eslint，以及全部73个Jest套件/813项测试通过，其中新增39项覆盖真实JwtStrategy、角色撤销、refresh token拒绝、DTO、UUID、Webhook边界、Service查询/幂等与迁移转换。测试依赖使用mock，不连接生产或真实MySQL。生产构建入口存在且离线脚本未进入dist。SQL执行、真实Docker私网、Nginx和MySQL联调/导入尚未执行，需在后续获准发布时验收。

## 登录用户开放范围调整（2026-10-28）

用户明确选择向所有已登录账号开放，取消管理员限制，保留登录。移除日记AdminGuard和前端login/profile角色判断；列表、单篇已读、全部已读均仅要求现有有效access JWT。普通用户放行，未登录、伪造/过期/refresh令牌及账号删除仍拒绝。不改变共享日记与已读语义，不改数据库或Webhook边界，也不调整其他模块管理员权限。旧实现验证记录中的角色撤销拒绝属于调整前的行为，本次回归改为降级后仍可读、账号删除后拒绝。

本次权限调整验证：本地73套件/816项Jest、lint、typecheck、build通过。PR #19合并后，[后台Actions 40661018421](https://github.com/1998yyh/tuanzii-server-base/actions/runs/40661018421) 成功，main提交aeed868。线上只读Controller元数据确认为单一JwtAuthGuard，未操作真实日记内容或已读状态。前文813项与管理员角色拒绝的记录为旧版本阶段，本段及当前权限说明为准。
