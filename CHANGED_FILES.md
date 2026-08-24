# 文件清单

- `src/ai.js`：有界 AI 调用、画像约束、两阶段评分、规则回退。
- `src/query.js`：检索词清洗、字段化查询和硬性数量限制。
- `src/index.js`：Workflow、双数据源检索、渐进式查询、去重缓存、安全与运行时迁移。
- `public/app.js`：不改 HTML/CSS/页眉，仅增加任务轮询和安全渲染。
- `wrangler.jsonc`：增加 `RADAR_WORKFLOW` 绑定。
- `schema.sql`：移除重复 ALTER，加入任务和处理缓存表。
- `package.json`：增加静态检查与测试命令。
- `test/ai.test.js`：评分边界和 AI 故障降级测试。
- `test/query.test.js`：Europe PMC/PubMed 查询构造回归测试。
- `UPGRADE.md`：部署步骤。
- `VALIDATION.md`：本地静态检查、单元测试和数据库脚本验证结果。
