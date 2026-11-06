# 技能导入 API 发布与生产网络适配

## 已完成的首轮发布

用户明确同意将后台源码合入公开 GitHub 仓库 1998yyh/tuanzii-server-base 并上线，同时新增 skills.source、skills.package_files 两个可空JSON字段。GitHub连接器创建PR返回403，本机既有Git身份可正常创建PR；没有调整仓库权限、认证协议或密钥。

- 功能提交467205e，经 [PR #26](https://github.com/1998yyh/tuanzii-server-base/pull/26) 合入main的e797676。
- [CI](https://github.com/1998yyh/tuanzii-server-base/actions/runs/42180662179) 和 [首轮发布](https://github.com/1998yyh/tuanzii-server-base/actions/runs/42180922996) 均成功；本地lint/typecheck/build与76套888项Jest及网关、认证挂载测试通过。
- 发布前数据库、配置已保存在服务器root私有目录，原应用镜像已添加回退标签；敏感内容未上传仓库或输出日志。
- ddl_history仅缺本次2026-11-05技能包迁移，Actions已执行并记账；两个字段均为JSON且允许NULL。发布前后既有技能数量均为1，没有保存测试技能。
- 市场和导入预览、Agent/Skill/MCP管理接口的匿名请求从404变为401；健康检查400。5209代理亦返回401，鉴权边界保持生效。

## 实际下载发现与修复

生产GithubSkillsService成功发现用户提供公开仓库的44个技能。选择技能后原始文件域名连接超时，60秒预览失败；同一服务器访问api.github.com可用，官方Git blob原始媒体响应与树中的SHA匹配。

修复仅在原始文件传输失败或超时时使用官方API，不引入镜像站或新凭据：

- 原始文件请求8秒超时，仍受总预览60秒预算控制。
- 失败后5分钟内使用API，避免每个文件重复等待；之后恢复尝试原始通道。
- 备用地址由已验证的仓库与不可变blob SHA构造，Accept为application/vnd.github.raw+json；继续公网检查、拒绝重定向、文件大小与Git SHA检查。
- 用户取消、HTTP错误、SSRF拒绝或内容校验失败不触发网络降级；GitHub限流保持明确报错。备用API也受GitHub公开访问配额约束。
- 无新的数据库迁移、环境变量、依赖或凭据，不自动安装或执行技能。

依据：[GitHub Git blobs文档](https://docs.github.com/en/rest/git/blobs#get-a-blob)。追加验证覆盖网络/超时备用通道、短期可用性记忆、错误内容校验、HTTP错误、SSRF与取消边界。修复的生产发布与最终验证将在实际完成后补齐。
