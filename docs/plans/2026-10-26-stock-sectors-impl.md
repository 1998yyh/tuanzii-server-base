# 循势股票行业与概念板块

## 背景与范围

循势筛选结果移除重复的市场、信号日期和固定 B 信号列，增加行业层级与主题概念。原信号接口只返回代码、名称、市场，因此新增独立的公开查询接口，避免第三方取数拖慢原日期缓存和扫描轮询。

日期：2026-10-26。分支：`feature/stock-sector-metadata`。前端对应分支：循势仓库 `feature/stock-sector-columns`。

## 接口与数据口径

`GET /api/stock-signals/sectors?codes=000030,600519`，不需要登录。DTO 校验逗号分隔的六位沪深主板代码，单批 1–50 只；重复代码去重，不接受外部 URL 或任意过滤表达式。

响应形状：

```json
{
  "items": [{
    "code": "000030",
    "industries": [{ "code": "BK1211", "name": "汽车", "level": 1 }],
    "concepts": [{ "code": "BK0984", "name": "华为汽车" }],
    "status": "ready",
    "source": "eastmoney",
    "fetchedAt": "2026-10-26T12:10:10.416Z"
  }]
}
```

上例只节选一项行业和一项概念；实际返回全部匹配项。数据源为[东方财富个股核心题材](https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/Index?type=web&code=SZ000030)，请求 `datacenter.eastmoney.com/securities/api/data/v1/get` 的 `RPT_F10_CORETHEME_BOARDTYPE` 报表。行业只接受 `BOARD_TYPE=行业` 且层级为 1、2、3 的记录，按层级排序；概念只接受 `BOARD_TYPE` 为空且 `IS_PRECISE=1` 的主题记录，按板块代码去重。地域、交易属性和指数成分不混为主题概念。

这是当前归属，不是查询信号日期时的历史板块快照。页面分别注明新浪信号来源和东方财富板块来源。

## 取数与降级

- 批量过滤代码，每页 500 条，读取全部分页；异常页数或超过 10 页视为来源异常，避免静默截断。
- 每次出站请求先执行 `assertPublicUrl`，禁止跟随重定向，单页超时 8 秒。
- 成功结果按股票代码缓存 6 小时，同一批并发查询合并。缓存只在当前进程内，重启会清空。
- 失败或响应缺少某只股票时返回 `status=unavailable`、空数组和 `fetchedAt=null`；失败缓存 60 秒，随后查询可以重新取数。不能将失败解释为该股没有板块。
- 成功数据中的空概念数组表示按上述主题口径没有概念；前端显示“暂无主题概念”。
- 不写数据库、不修改观察池、不触发市场扫描；原有信号与观察池接口无变化。

## 变更文件

- `src/stock-signals/dto/query-sectors.dto.ts`：输入转换和校验。
- `src/stock-signals/stock-sectors.controller.ts`：公开 GET 与 Swagger 文档。
- `src/stock-signals/stock-sectors.service.ts`：取数、分类、分页、缓存与降级。
- `src/stock-signals/stock-signals.module.ts`：注册控制器与服务。
- `test/stock-signals/stock-sectors.service.spec.ts`：分类、分页、缺失、超时、缓存、并发和 SSRF 校验测试。
- `test/stock-signals/stock-sectors.controller.spec.ts`：真实本地 HTTP 路由、公开访问与全局 ValidationPipe 行为测试。
- 本文：记录实现、验证、发布和回退步骤。

## 验证

`pnpm lint`、`pnpm typecheck`、`pnpm build` 通过。服务与 HTTP 契约专项测试共 15 项通过；全量 Jest 64 个套件、699 项测试全部通过。隔离单测不连接真实数据库和市场扫描服务。

另外通过本地 `StockSectorsService.get(['000030', '600519'])` 读取真实东方财富数据，两只股票均返回 `ready`；富奥股份包含“汽车 → 汽车零部件 → 底盘与发动机系统”，以及华为汽车、低空经济等主题概念。该检查仅查询公开板块数据。

## 发布、兼容与回退

无新依赖、环境变量、数据库结构或迁移。先合并并发布后端接口，再发布循势前端。后端现有 main 推送会触发自动发布；本任务只提交分支，不推送 main、不部署。

前端遇到旧后端 404 时保留股票结果，板块显示“暂不可用”；因此应先发后端以避免缺失提示。当前接口依赖第三方公开报表字段；来源异常将降级，后续字段调整需维护解析。

回退时先恢复旧前端，再撤销本任务新增文件及模块注册；不涉及数据回滚。后端工作目录为独立 Git worktree，原 `tuanzi-server-base` 中未提交的其他任务改动保持原状。
