# 日志采集与存储：官方资料核验

核验日期：2026-09-14。仅使用厂商文档；这是选型资料，不代表线上已部署或完成可靠性测试。

## 选型建议

推导建议：若优先减少运维且已有腾讯云账号，优先验证 CLS 接入；若明确希望自托管，采用 Alloy → Loki → Grafana。单机 Loki 可以起步，但不能把同机磁盘当作独立故障域。暂不引入 Kubernetes 只为采集日志。

| 维度 | 腾讯云 CLS | Alloy + Loki + Grafana |
| --- | --- | --- |
| 采集 | LogListener；官方有主机文件与 K8s 标准输出接入文档，裸 Docker/Compose 接入步骤仍需验证 | Alloy `loki.source.docker` 经 Docker API 采集，有官方组件说明 |
| 存储 | 托管主题，可配置生命周期 | 自管磁盘或对象存储；需配置 Compactor 删除策略 |
| 查询 | CLS 检索分析、仪表盘、告警 | Grafana 连接 Loki，使用 LogQL |
| 成本 | 实测日志量、索引范围、保存天数、地域、网络后估算账单 | 机器、磁盘、备份、网络和运维时间；不能只计算软件许可 |

表中事实依据见后文；运维投入比较为基于架构的判断，未实测吞吐或费用。

## CLS：能力与接入边界

- CLS 支持 LogListener、API/SDK、Kafka、OpenTelemetry 等接入方式。[采集概述](https://cloud.tencent.com/document/product/614/33494)
- 官方主机文件采集支持路径通配与 JSON 提取；可以让应用把单行 JSON 写入挂载到宿主机的专用日志目录，再由 LogListener 采集，需单独管理文件轮转与重启行为。[文件采集](https://cloud.tencent.com/document/product/614/17421)、[JSON 提取](https://cloud.tencent.cn/document/product/614/17419)
- 本次查到的标准输出自动发现流程主要面向 TKE/自建 K8s，使用命名空间、工作负载和 Pod 标签筛选；不能据此承诺裸 Docker Compose 有相同控制台流程。裸 Docker 原生采集须按目标 LogListener 版本另做 PoC，或核实厂商支持的接入方式。[TKE 接入](https://cloud.tencent.com/document/product/457/36771)、[自建 K8s 配置](https://intl.cloud.tencent.com/zh/document/product/614/42745)
- 不建议把直接读取 `/var/lib/docker/containers/*/*-json.log` 当默认方案：Docker 官方说明内部 JSON 文件由 daemon 专用，外部工具操作可能干扰日志系统。[Docker JSON 驱动](https://docs.docker.com/engine/logging/drivers/json-file/)
- 标准主题生命周期支持 1–3600 天或永久；低频主题最少 7 天。建议先保留 14–30 天标准日志，是否增加低频历史存储取决于实际检索需求。[规格与限制](https://intl.cloud.tencent.com/zh/pdf/document/614/11031?domain=intl.cloud.tencent.com&lang=zh)
- 按功能计费需考虑写流量、索引流量、日志存储、索引存储、请求和可能的数据处理/外网读取等费用。另有按原始日志量计费，但官方说明中国站且白名单开放，不能默认账号可用。不引用固定月费，先采样 7 天再按地域价格计算。[产品定价](https://cloud.tencent.com/document/product/614/45803)
- 缩短生命周期会影响现有有效数据；变更前应确认历史排障需求。[计费及生命周期规则](https://cloud.tencent.cn/document/product/614/45802)

## Alloy / Loki：上线前容易遗漏的设置

- Promtail 已在 **2026-03-02 EOL**，官方声明不再支持或更新。新方案选择 Alloy。[Promtail 生命周期](https://grafana.com/docs/enterprise-logs/latest/send-data/promtail/)
- `loki.source.docker` 在组件数据目录保存 positions，供组件或进程重启后续读。必须持久化 Alloy storage path，组件命名也要保持稳定。[Docker source](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/)
- positions 是读取进度，不是 Loki 接收确认。`loki.write` 有有限重试配置；除可配置重试的 429 外，其他 HTTP 4xx 不视为可恢复错误。其 WAL 默认禁用，当前官方标记为 experimental，开启要求实验特性等级，且有 segment age 等边界。不能把“持久化 positions”描述成“断网日志保证补齐”。[Loki write](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.write/)
- 推导边界：源日志先被 Docker 轮转删除、采集器磁盘损坏、下游长期拒收等情况下，positions 无法恢复已不存在的数据；需用编号日志实际测重启、断网、恢复及容器重建，记录缺失与重复。
- Loki retention 默认关闭；仅设置 `limits_config.retention_period` 不够。TSDB 使用 24h index period，开启 `compactor.retention_enabled`，设置 `delete_request_store`，持久化 compactor 工作目录中的删除标记，并在测试环境验证历史数据确实过期。[Retention](https://grafana.com/docs/loki/latest/operations/storage/retention/)
- filesystem 存储可令 `delete_request_store: filesystem`。Loki 不会因磁盘将满自动删除日志；必须监控可用空间、inode 与增长趋势。其耐久性取决于底层文件系统，同机部署不能应对主机磁盘丢失。[Filesystem store](https://grafana.com/docs/loki/latest/operations/storage/filesystem/)
- 初始索引标签仅建议 `service`、`env`、`level` 等有限值；`requestId`、`conversationId`、`runId`、`traceId` 留在 JSON 字段或 structured metadata，避免每次请求生成新日志流。[标签基数](https://grafana.com/docs/loki/latest/get-started/labels/cardinality/)
- Docker 本地轮转要显式规划；`json-file` 默认不轮转，修改 daemon 默认值不会自动应用到现有容器，须重建容器。轮转容量是本地缓冲窗口，不是长期保存天数。[Docker logging 配置](https://docs.docker.com/engine/logging/configure/)

## 下一步验收建议

1. 先确认线上云厂商、机器资源和日志日增量；选定一个目标链路，固定组件版本。
2. 应用统一单行 JSON；包含时间、级别、服务、环境、请求/Agent 执行标识、上游 HTTP 状态及脱敏错误类型。聊天正文和密钥不进入默认排障日志。
3. 在测试环境写入带序号日志，覆盖采集器重启、网络短断、下游拒收、容器重建；比较数量、缺号与重复。
4. 验证保留期删除、容量告警、权限及历史日志查询；生产接入后按真实用量调整保留周期与索引。

以上步骤为项目实施建议，尚未执行。
