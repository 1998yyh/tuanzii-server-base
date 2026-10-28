# Tuanzi Server Base

团子后台基础服务，包含用户认证、Agent 平台及业务模块。小肥鱼日记后台统一位于本仓库 `src/xiaofeiyu-diary/`，不另建服务或仓库。

## 技术栈

- **框架**: NestJS 11 + TypeScript 5.8
- **数据库**: MySQL 8.0 + TypeORM
- **认证**: JWT + Passport
- **文档**: Swagger
- **规范**: ESLint 9 (flat config) + Prettier + husky/lint-staged + commitlint
- **包管理**: pnpm

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动数据库

```bash
docker-compose up -d
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，修改数据库密码和 JWT 密钥
```

### 4. 启动开发服务器

```bash
pnpm start:dev
```

服务启动后：
- API 地址: http://localhost:3000/api
- Swagger 文档: http://localhost:3000/api/docs

## 常用命令

```bash
pnpm lint            # ESLint 检查并自动修复
pnpm format          # Prettier 全量格式化
pnpm typecheck       # tsc --noEmit 严格类型检查
pnpm test            # 运行全部 Jest 测试
pnpm test:cov        # 测试覆盖率
```

> 提交代码时会自动触发 pre-commit 钩子（lint-staged: eslint --fix + prettier）
> 以及 commit-msg 钩子（commitlint 校验 conventional commits 格式，如 `feat: xxx`）。

## API 接口

### 认证模块

| 方法 | 路径 | 描述 | 认证 |
|------|------|------|------|
| POST | /api/auth/register | 用户注册 | 否 |
| POST | /api/auth/login | 用户登录 | 否 |
| GET | /api/auth/profile | 获取用户信息 | 是 |
| POST | /api/auth/refresh | 刷新令牌 | 是 |

### 注册请求示例

```json
{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "Password123!"
}
```

### 登录请求示例

```json
{
  "login": "user@example.com",
  "password": "Password123!"
}
```

### 登录响应示例

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 7200
}
```

## 项目结构

```
src/
├── main.ts                 # 应用入口
├── app.module.ts           # 根模块
├── auth/                   # 认证模块
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── jwt.strategy.ts
│   └── dto/
│       ├── register.dto.ts
│       └── login.dto.ts
├── users/                  # 用户模块
│   ├── users.module.ts
│   ├── users.service.ts
│   ├── users.entity.ts
│   └── dto/
│       └── user.dto.ts
└── common/                 # 公共模块
    ├── guards/
    ├── decorators/
    └── filters/
```

## 环境变量说明

| 变量 | 描述 | 默认值 |
|------|------|--------|
| NODE_ENV | 运行环境 | development |
| PORT | 服务端口 | 3000 |
| DB_HOST | 数据库地址 | localhost |
| DB_PORT | 数据库端口 | 3306 |
| DB_USERNAME | 数据库用户名 | root |
| DB_PASSWORD | 数据库密码 | - |
| DB_DATABASE | 数据库名 | tuanzi_server |
| JWT_SECRET | JWT 密钥 | - |
| CORS_ORIGINS | CORS 允许的域名 | * |

## 数据库管理

使用 Adminer 管理 MySQL：
- 地址: http://localhost:8080
- 系统: MySQL
- 服务器: mysql
- 用户名: root
- 密码: root_password
- 数据库: tuanzi_server

## 生产部署

1. 设置环境变量 `NODE_ENV=production`
2. 设置强密码和安全的 JWT_SECRET
3. 设置 `synchronize: false` 或使用迁移
4. 使用 `pnpm build` 构建后运行 `pnpm start:prod`

## License

ISC

本项目包含从 [infinite-canvas](https://github.com/basketikun/infinite-canvas)（AGPL-3.0）移植/改写的代码，相关文件头部有来源注释，详见根目录 [NOTICE](NOTICE)。

## 股票扫描记录保留期

扫描任务及 B/空值缓存仅保留上海日期最近 30 个自然日（含今天），应用启动后和每天 00:10 自动清理。进行中扫描的整个日期暂不清理；观察池依赖的历史 S 事件独立保留。查询和新扫描接口同步限制窗口，详见 [实现与发布说明](docs/plans/2026-10-27-scan-history-retention-impl.md)。

## 小肥鱼日记

日记前端独立，后台作为 Nest 模块复用现有JWT、账号身份和MySQL。提供分页/搜索/未读筛选、单篇/全部已读，以及仅供本机直连的密钥 Webhook。所有已登录账号均可阅读和标记已读，不限制管理员角色；所有登录用户共享日记及已读状态。

- 阅读：`GET /api/xiaofeiyu/entries`，写已读：`POST /api/xiaofeiyu/entries/:uuid/read`、`POST /api/xiaofeiyu/entries/read-all`。
- 推送：`POST /api/internal/xiaofeiyu/webhook`，`X-Xiaofeiyu-Key` 请求头或兼容 query key；公网 Nginx 必须阻断此路径及 API 别名。
- 可选环境项：`XIAOFEIYU_WEBHOOK_KEY`（32–256 字符），留空仅关闭推送，不影响共享后台启动。不要写进前端或日志。
- DDL：`docs/plans/2026-10-28-xiaofeiyu-diary.sql`，遵守原有发布迁移流程。旧 SQLite 需显式离线导入，不自动执行。

详见 [实现与迁移说明](docs/plans/2026-10-28-xiaofeiyu-diary-impl.md)。本次权限调整已通过 [PR #19](https://github.com/1998yyh/tuanzii-server-base/pull/19) 合并并由 [GitHub Actions](https://github.com/1998yyh/tuanzii-server-base/actions/runs/40661018421) 发布成功。线上Controller仅保留JwtAuthGuard，所有有效登录账号可访问；未登录仍需登录。本次无新增DDL、数据导入或生产日记写入。
