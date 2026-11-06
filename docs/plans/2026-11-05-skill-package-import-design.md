# GitHub 与市场技能包导入

## 行为与边界

Skills 管理新增 GitHub 和市场入口。导入前解析标准 SKILL.md 的 YAML 与 Markdown，展示名称、描述、不可变提交版本、许可/环境要求及目录文件，用户确认后入库。仓库内多个技能先选择单个目录。名称按现有工具名约束规范成 snake_case，原名和完整文件保持在来源/快照中；重名可改名重试，不覆盖现有 Skill。

市场首批为 `anthropics/skills` 中的八个精选目录，不提供虚构下载量/评分。每次预览重新解析分支到提交 SHA，文件从该不可变版本下载并按 Git blob SHA 校验。原始文件域名网络失败时，使用 GitHub 官方 Git blob 原始媒体 API 按同一 SHA 下载，仍执行相同大小与哈希检查。2026-11-05 已用真实公开 GitHub 来源验证全部八项；浏览器 HTTP 联调用存储和下载替身，不写生产库。

不使用 git clone、shell、eval、安装脚本或代码执行。保存目录内 SKILL.md、references、scripts、assets 及其他普通文件。仅接受公开 GitHub HTTPS 来源，API/下载地址由服务端构造，检查公网 DNS；禁止重定向、符号链接、子模块、控制字符和路径穿越。上限为单包 160 文件/4 MB、单文件 512 KB、SKILL.md 60 KB（兼容现有 TEXT 列）。YAML 禁止别名和重复字段。下载总截止时间 60 秒，用户断开会取消下载，限制每用户和全局并发，JSON 元数据缓存有大小与项数预算。

## 存储

执行 `2026-11-05-skill-package-import.sql`，只新增两个可空 JSON 列：

- `skills.source`：仓库、ref、commit SHA、SKILL.md 路径、源链接、原始名称、许可、环境要求、导入时间与大小统计。
- `skills.package_files`：相对路径、UTF-8/base64 内容、字节数和 blob SHA。实体设为 `select:false`，列表不加载或回传文件正文。

创建技能与文件快照在单次 repository.save 中保存。编辑导入技能的系统指令时同步包内 SKILL.md、计算新 SHA/大小并标记 modified，保留其他资源。来源和文件不能从普通 CRUD DTO 注入。历史手工技能不做数据迁移，source/files 为 null。2026-11-06 起手动和导入技能统一在当前 Agent 执行，见同目录 current-agent-skills-design。

## 接口

- GET `/api/skills/market`：管理员读取精选来源列表。
- POST `/api/skills/imports/preview`：管理员提交公开 GitHub 链接与可选版本。返回候选目录或完整技能快照、previewId 和有效期。
- POST `/api/skills/imports`：管理员提交 previewId、平台名与描述。预览绑定用户、十分钟过期；安装同一快照，不重新读取移动分支。安装中串行保护，重名失败保留预览，网络失败重试已完成安装不会重复创建。
- DELETE `/api/skills/imports/:id`：丢弃自己的预览。
- GET `/api/skills/:id/package`：已登录用户按现有全局技能可见性查看来源与文件快照。

复用 Cookie/CSRF/JwtAuthGuard。普通用户不能触发导入。缓存仅用于预览和短期幂等结果，进程重启后未确认预览需重新解析。

## 执行

2026-11-06 调整：SkillToolFactory 统一提供 skills_list / skills_read / skills_read_file。模型先看到名称和描述，按需读取完整说明与引用，后续直接使用当前 Agent 的工具和 MCP 执行，不启动 Skill 子 Agent。历史 Skill.enabledTools、mcpServers、inputSchema 继续存储但不参与执行或扩大权限。说明、文件作为工具结果进入当前会话，不覆盖 Agent 的系统消息；不运行包内脚本。详见 `2026-11-06-current-agent-skills-design.md`。

## 发布

发布涉及一个新依赖 `yaml@2.9.0`、两个可空列、Skills 模块与 Agent 的包工具绑定。先按迁移历史执行加列，再发布后端，最后使用前端新入口；旧应用忽略新增列。禁止为上线打开 synchronize。回滚应用时保留新列与已导入数据，不删除来源快照。

2026-11-06 已通过 PR #26 合入并发布管理接口、技能包迁移和当前会话执行机制，同时保留 DeepSeek 搜索修复。生产下载验证发现 raw.githubusercontent.com 超时，后续下载兼容修复与最终验收记录见 `2026-11-06-skill-import-release.md`；其他任务的媒体改动未纳入。

## 验证

后端全量 76 套、888 项测试通过，含真实 LangChain 搜索回归与新导入边界。类型检查、构建、全仓 ESLint 通过。导入测试覆盖 YAML、来源路径、Git blob 校验、多技能发现、非法文件、限流、跨用户预览、重名重试、TTL、幂等、包内文件访问、宿主工具权限与修改后快照同步。前端通过 lint/build、既有 AI 浏览器回归及新增导入浏览器联调；详见后台前端 README。

用户于2026-11-06明确批准本次后台版本在公开仓库合并发布及两个可空字段的生产迁移；不再沿用此前仅保留本地的发布选择。
