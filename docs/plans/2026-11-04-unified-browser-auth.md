# 统一浏览器认证实施与切换

用户已批准：同一个 HTTPS IP 入口、独立前端、共享后端会话；dsh 只授权现有用户名 `tuanzi`。登录视觉采用原型 A，原始比较提交保留在 personal-homepage 的 `codex/prototype-unified-login` 分支。

## 代码与边界

- 账号与 bcrypt 密码复用 `users`。新增 `auth_version`、`auth_sessions`、`user_app_grants`，DDL 走现有流水线，禁止 synchronize。
- 随机 256 bit 凭据通过 `__Host-tuanzi_session` 传输，只存 SHA-256 哈希；Cookie 为 Secure、HttpOnly、Path=/、SameSite=Lax，无 Domain。
- 默认空闲 2 小时、绝对上限 12 小时；记住设备为绝对 7 天。正常浏览器会话不承诺关标签页即退出。过期超过 30 天的行由每日任务清理。
- 写操作必须具有固定 AUTH_ORIGIN 和会话绑定的 X-Tuanzi-CSRF。登录使用 JSON 和 X-Tuanzi-CSRF: login，并检查 Origin。GET/HEAD 不执行业务写操作。
- 每次请求查会话和现有用户；403 不撤销登录，数据库错误不会变成 401。明确给出 Authorization 时不回退 Cookie。
- 当前设备、指定设备、全部设备均可撤销；全部撤销在事务内递增用户认证版本，与登录的行锁串行化。
- SSE 主动撤销立即断开，到期最多 30 秒检查；已启动的业务任务不自动回滚。dsh 网关对流和 WebSocket 最多 30 秒复核身份与授权。
- 前端移除本地 JWT 存储、刷新和写操作自动重放。BroadcastChannel 只广播身份变更事件；焦点恢复时重查，异步响应按代际丢弃。仅清除指定旧令牌键，不清业务设置。
- 日记继续所有登录用户共享；循势观察池继续按原 userId 隔离；后台继续 admin guard；dsh 需要额外 app grant，管理员不会自动获得。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | /api/auth/session | 登录并设置 Cookie；正文 login/password/remember |
| GET | /api/auth/session | user/apps/csrfToken/expiresAt，no-store |
| DELETE | /api/auth/session | 当前设备退出，204 |
| POST | /api/auth/logout-all | 全部设备退出，204 |
| GET | /api/auth/sessions | 当前用户设备列表，不含凭据或哈希 |
| DELETE | /api/auth/sessions/:id | 当前用户指定设备退出，204 |
| GET | /api/auth/dsh-access | 网关复核会话及 dsh grant；不返回上游凭据 |

新前端全部使用同源 `/api`。旧 `/xunshi/api`、`/xiaofeiyu/api` 即使保留，也必须进入相同 guard，内部 Webhook 的已有别名阻断继续保留。

## 配置与兼容窗口

WEB_SESSION_ENABLED 默认 false，先迁移和准备 HTTPS，再开启；AUTH_ORIGIN 固定为 `https://43.140.214.49`；AUTH_CSRF_SECRET 为独立 32 字节十六进制密钥，稳定保存在 root 管理的 `/etc/tuanzi/auth.env`，不进入 Git。

流水线继续下发基础 `.env.production`；Docker 守护进程将 root 私有的 `/etc/tuanzi` 只读挂载到应用。`scripts/start-with-auth.cjs` 在启动 Nest 之前只解析允许的认证字段，不执行配置文本。宿主机保持目录 0700、文件 0600，deploy 账号不能直接读取或修改该配置；认证密钥不追加到 deploy 所有的环境文件，内容不回显。密钥用服务器上的 `openssl rand -hex 32` 写入受保护文件，不在聊天或命令输出中传递。

LEGACY_JWT_ENABLED 默认 true。迁移期间旧前端可继续运行；全部新前端和调用方验证后设为 false，拒绝旧 Bearer、登录、刷新和注册协议。既有注册页仅在兼容窗口通过旧注册接口创建账号，然后建立新 Cookie 会话，不读取旧 JWT；关闭兼容窗口后不再开放该旧注册入口。若仍有脚本依赖旧 JWT，必须先迁移或明确安排独立协议，不能宣称已全局撤销旧凭据。

## HTTPS 与 dsh 的切换步骤（本轮已完成，实际结果见末尾）

1. 备份数据库及当前 Nginx、dsh unit，核对受保护入口、80/443 安全组和 `/var/www/admin` 的实际发布目录。不要关闭无关公开服务。
2. 用现有 80 端口站点提供 `/.well-known/acme-challenge/`，目录 `/var/lib/letsencrypt`。先只加验证 location，不先跳到尚未就绪的 HTTPS。
3. 在专用 `/opt/tuanzi-certbot` 安装支持 IP/webroot 的 Certbot 5.4 或更高版本。申请示例：`certbot certonly --webroot -w /var/lib/letsencrypt --ip-address 43.140.214.49 --preferred-profile shortlived --non-interactive --agree-tos --register-unsafely-without-email`。可改用运维邮箱接收通知，但不必提供给前端。正式证书前可先使用 staging 验证。
4. 核对实际证书目录再应用 `deploy/unified-session.nginx.conf.example`，`nginx -t` 后 reload。确认浏览器信任 IP 证书且续期挑战路径可达，再把普通 HTTP 请求改为 308。
5. 安装 `tuanzi-cert-renew.service/timer`，每日检查两次，随机延迟，开启 Persistent；运行 renew --dry-run 验证挑战和 reload hook。IP 证书短期有效，续期成功和证书实际加载必须检查。
6. GitHub CI 验证后先发布后端并执行 DDL。检查 `user_app_grants` 中 dsh 仅对应用户名 tuanzi。未匹配该用户时不授权任何人，不能临时给所有管理员开放。
7. 认证配置先启用 Cookie 会话、保留 legacy，再发布主页、循势、小肥鱼、后台。逐个测试匿名访问、登录回跳、权限、换号、跨标签退出和设备撤销。
8. dsh 由现有 `dshwhale` 用户运行。审核 drop-in 与网关 service 后，由 `capture-dsh-launch.mjs` 接管新进程的启动输出，将新凭据写到 0700 runtime 目录、0600 文件，日志不保留启动 URL；网关只监听 127.0.0.1:3081，dsh 继续在 127.0.0.1:3080。
9. 所有 `/dsh/` HTTP、API、上传和升级请求改经网关；不保留旧直通 3080 的 location。上游 Cookie 只在服务端，客户端 Cookie/Authorization/身份头不传到 dsh；源 Origin 先验证后转为固定上游 authority。
10. 完成真实浏览器联调后关闭 legacy，确认旧端口或别名不能绕过新入口。PUBLIC_BASE_URL 如需改为 HTTPS，随现有发布配置协调，历史数据不批量改写。

## 验证与已知限制

- 后端 74 套件、849 用例已本地通过；另有 dsh 网关隔离测试验证先授权、上游 Host、凭据不泄漏、来源拒绝与启动 token 变化。
- 管理后台使用真实会话服务/CSRF/角色 guard 的内存夹具完成浏览器回归；四前端同站点联调通过共享身份、403 不退出、HttpOnly、无本地 token、跨项目退出、换号和全部设备撤销。
- 真实 MySQL DDL/ORM 检查由 `session-ci.yml` 中全新 `auth_session_test` 数据库执行，脚本强制固定测试库，不能使用生产数据库名。本机未执行真实 MySQL 检查；已由远端 CI 成功补齐（最终配置加载版本的检查见 Actions 41823078558）。
- 用户后续明确授权部署。现网 dsh 握手已验证成功：使用新的启动捕获流程和短期测试会话，确认上游 Cookie 不下发浏览器、匿名回统一登录、跨站写拒绝；没有读取历史日志启动凭据。
- dsh 仍是一个共享操作实例，统一身份不等于多人文件/会话隔离。

## 回退

业务代码与前端需协调回退；DDL 只增加表列，按既有规范不回滚数据库。旧应用忽略新增结构。恢复旧前端前先重新启用 legacy；若认证系统尚不可用，dsh 入口保持关闭或回到原有 token 鉴权，绝不做匿名直通。Nginx 与 unit 用备份还原并测试后 reload。HTTPS 已生效时继续保留受信任证书与续期任务。密钥、数据库和真实日记不进入构建包或提交。

## 2026-11-04 生产发布记录

- 后端 PR #24/#25 已合并并通过 Actions 发布（最终部署 41823408479）；增量 DDL 已记账，dsh grant 仅匹配现有用户名 tuanzi。
- 主页、循势与小肥鱼已发布。普通 HTTP 请求 308 到 HTTPS；旧注册页面回统一登录。LEGACY_JWT_ENABLED 已设为 false，线上验证合法签名旧 Bearer 被拒绝、旧密码登录关闭；浏览器 Cookie 会话保留。
- IP 正式证书已安装；公网 443 由用户放行后验证成功。tuanzi-cert-renew.timer 已启用，renew --dry-run 与 Nginx 重载钩子通过。
- auth.env 由 root 持有，目录 0700、文件 0600。曾提议给 deploy 只读权限，被自动审批拒绝；最终采用应用只读挂载，未放宽宿主机权限。
- dsh-whale 与网关以 dshwhale 运行，端口分别为回环 3080/3081；所有外部 dsh 请求经网关。启动 token 仅进入私有 runtime 目录，不读取历史日志。
- 保留现有 80 站点共享 include 供静态激活脚本检查，使用仅 return 的服务器级规则跳转 HTTPS，ACME 验证除外；443 站点使用同一共享路由。内部 Webhook 各别名持续 404。
- 管理后台按用户决定仅保留本地分支/产物，线上 /admin/ 显示尚未发布说明。
- 主站 rsync 排除独立维护的 /documents/，保留原有 PDF；未删除或改写真实日记、观察池与消息。
- 线上浏览器使用最终删除的短期测试会话，验证登录表单错误反馈、真实共享身份、HttpOnly/无本地 token、dsh 页面与认证交接、来源拒绝及跨项目退出；业务列表在测试浏览器隔离并禁止业务写，不发送 dsh 命令。
- 数据库、Nginx、原 dsh unit 与激活脚本备份保存在服务器 root 私有目录 /var/backups/tuanzi/unified-auth-20261104；不加入 Git。
