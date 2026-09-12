# 模块与维护入口

本文件已由旧覆盖包清单更新为当前模块索引；完整目录、命令和约束以 [AGENTS.md](./AGENTS.md) 为准。

| 文件 | 当前职责 |
| --- | --- |
| src/index.js | Worker 路由、Workflows 与定时入口 |
| src/ai.js、src/query.js | 有界 AI、规则回退、检索词约束 |
| src/radar.js | 论文身份与分层检索策略 |
| src/search.js | 外部检索、超时与有限重试 |
| src/storage.js、src/migrate.js | D1 存取与幂等迁移 |
| src/utils.js | 公共工具与安全辅助 |
| public/index.html、public/styles.css、public/app.js | 页面结构、Tools 视觉与任务进度交互 |
| wrangler.jsonc、schema.sql | 部署绑定与新建数据库结构 |
| test/ | 查询、AI、身份、检索策略及请求错误回归 |
| UPGRADE.md、VALIDATION.md | 升级方式与实际验证范围 |
