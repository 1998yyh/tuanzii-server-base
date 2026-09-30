# 轻量文件日志与管理员查询页面

用户确认：4 核 / 4GB 内存 / 约 40GB 磁盘，自建降低费用，最多保留 14 天。最终采用文件存储与独立管理前端 `tuanzi-admin`；此前 Alloy/Loki/Grafana 方案未实施，选型资料仅供以后扩容参考。

## 数据链路

Nest Logger → FileLogger（上下文、白名单、脱敏）→ LogStore 有界异步写队列 → 本地 JSONL 分片 → 历史 gzip。

管理员 → 独立前端 `/logs` → JWT + 管理员守卫 → 单日有界扫描 → 倒序分页、展开详情。

本次仅采集应用通过 Nest Logger 输出的日志和新增 HTTP/SSE 执行事件。Nginx/MySQL 独立进程日志、直接 console 输出不进入文件日志页；Docker stdout 仍保留作应急排障。聊天与工具业务数据仍走既有存储，不复制到排障日志。

## 保留与资源边界

- 上海日期分区，今天加前 13 天；早于此范围的文件由启动和每分钟维护清理。
- JSONL 分片目标 1MiB，单条最大 16KiB；大记录降为短摘要。
- 旧日期分片分批 gzip，每次最多处理约 8MiB 原文，避免维护长时间占用写队列。
- 受管理日志文件总预算 2GiB，轮转与维护时提前清理最旧分片并为下一分片预留空间。14 天是上限；容量触顶可提前清理。压缩临时文件存在短暂额外空间占用。
- 1MiB 内存写队列，满时丢弃新增条目并计数；文件写失败回退 stderr 提示并计数，不向聊天请求抛写盘错误。状态接口公开当前进程丢弃数量和最近写入异常标记。
- 有序异步写入、退出钩子排空队列；不保证 SIGKILL、断电、磁盘损坏情况下零丢失，也不是审计日志系统。
- 单进程写入；不支持多个应用实例共享目录。日志目录必须仅服务账号可写。

## 字段与检索

基础字段：id、UTC timestamp、level、message、context。HTTP 中间件生成 requestId 并返回 `X-Request-Id`，AsyncLocalStorage 关联同次请求日志，不接受客户端伪造的关联 ID。

SSE 记录 agent.run.started/completed/failed/cancelled，包含 conversationId、runId、agentId、channelId、modelName 与 durationMs。HTTP 200 不代表模型执行成功，应查看 agent.run.failed。模型绑定记录 model.config.resolved，包含 apiFormat、searchKind 和 upstreamHost，可按相同请求 ID 关联搜索方式与失败原因。普通请求记录 http.request.completed；不记录每个 SSE token。

错误白名单保存脱敏 message、stack、上游状态码等，禁止把整个 SDK request/response 对象序列化。普通字段不接收聊天 content/reasoning、工具输入输出、密钥、Cookie。自由文本额外处理 URL 查询参数和用户信息、Bearer/Basic、JWT、常见密钥字段。日志摘要不能作为模型返回正文的完整副本。新增业务日志时仍应只传诊断字段，不能依赖正则识别所有未知凭据格式。

## API 合约

两个接口都要求有效 JWT 且 `user.role === admin`，成功响应 `Cache-Control: no-store`：

- `GET /api/admin/logs?date=YYYY-MM-DD&level=error&conversationId=...&requestId=...&limit=200&cursor=...`
  - date 默认上海今天，仅允许最近 14 天真实日期。
  - level 可选 info/warn/error/debug/fatal；两个 ID 精确匹配；最多 200 条。
  - 返回 `{ items, nextCursor, scanLimited }`。无总数，避免每次全量扫描。
  - 每次约 8MiB 解压后扫描预算、分片边界约 3 秒检查；单次内存只加载一个约 1MiB 分片。不是硬实时响应 SLA，磁盘枚举/单片 I/O 可能更久。
  - 同时最多一个扫描请求，重叠请求 429。scanLimited 表示尚未扫完整天，即使 items 为空也可继续查找。
  - 游标绑定筛选条件和分片行号，追加新日志不会使下一页重复；文件清理后返回 400 提示重新查询。
  - 路径和正则不是 API 参数；读取固定命名分片并拒绝符号链接；损坏分片明确返回 503。
- `GET /api/admin/logs/status`
  - 返回 totalBytes/maxBytes/retentionDays/dates/today/oldestDate/droppedRecords/writeFailed。
  - 另返回 checkedAt 与 days（date/totalBytes/compressedBytes/fileCount），仅汇总文件元数据，不解压内容。
  - 不返回宿主机路径、文件名或凭据。

独立前端使用 Vue 3 + Vite + fetch，A 后台布局结合 C 常驻详情；窄屏使用原生 dialog 抽屉。登录后通过 profile 核实管理员角色，access token 使用独立 sessionStorage，401/403 清理会话；到期重新登录，不保存 refresh token。查询条件同步 URL，每页最多 50 条，切换条件清空游标，取消过期请求，默认不轮询。扫描受限时可继续扫描，空页不等于查询完毕。日志详情使用文本插值，仅展示实际字段。概览最多查询今天 10 条 ERROR，不伪造全天计数；存储页面只读取 status。

## 部署

本地默认目录为后端根 `logs/`，可通过 `LOG_DIRECTORY` 指定固定目录。生产 Compose 已配置：

```yaml
environment:
  LOG_DIRECTORY: /var/log/tuanzi
volumes:
  - /var/log/tuanzi:/var/log/tuanzi
logging:
  driver: json-file
  options:
    max-size: '10m'
    max-file: '3'
```

宿主机目录在源码发布目录外，不受现有 rsync --delete 影响。当前镜像以 root 运行，可由 Docker 建立目录；将来改服务 UID 时须同步目录所有权。目录不在 `/uploads` 静态路径内，禁止额外映射为静态服务。

后端与独立 `../tuanzi-admin` 前端需要配套发布；`personal-homepage` 中早期新增的日志入口已迁出。前端构建产物由现有 Nginx 静态提供，`/api/` 同源代理到后端，无额外 Node 常驻服务。参考前端 `deploy/nginx.conf.example`。需要重建 app 容器以应用挂载与 Docker logging 配置，无需数据库 DDL，也无需部署日志数据库。此文档不表示已发布生产。

日志从新版启动后开始采集，不回填原有 Docker 日志。Docker stdout 本地轮转副本最多约 30MiB，另计于 2GiB 文件预算。维护预算不覆盖其他程序文件；仍需关注宿主机总体磁盘空间。

## 验证与排障

```bash
pnpm exec jest --runInBand test/logs test/agents/conversations.controller.spec.ts
pnpm typecheck
pnpm build
```

测试覆盖真实临时文件的压缩/重启/14天清理/容量预算、分页与追加、扫描上限、错误游标、路径与符号链接、并发维护、损坏压缩文件、脱敏、HTTP 管理员权限及参数校验、并发 requestId 隔离和 HTTP 200 的 SSE 失败日志。HTTP 身份认证使用测试替身，生产仍使用现有 JwtAuthGuard。

前端运行 `pnpm test`、`pnpm lint`、`pnpm build`。浏览器已用真实 AuthService/JwtStrategy/LogsController/LogStore + 隔离测试账号和临时文件验证登录、权限、查询、分页、详情、存储、窄屏和过期处理；异常 API 替身用于扫描上限与重试。完整业务服务、生产 MySQL/Nginx 和真实模型渠道尚未联调。

排查模型错误：选发生日期 → 粘贴会话 ID → 找 agent.run.failed → 展开上游状态/摘要 → 用 requestId 关联 model.config.resolved。如页面提示日志写入异常，检查宿主机目录权限、空间及容器 stderr；计数仅代表当前进程，不是历史丢失总量。
