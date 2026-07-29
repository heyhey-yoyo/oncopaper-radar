# AGENTS.md

本文件供 AI 编码代理阅读，描述 OncoPaper Radar 项目的架构、命令与约定。

## 项目概述

OncoPaper Radar 是一个部署在 **Cloudflare Workers** 上的个人科研文献雷达 Demo，面向肿瘤分子机制研究。核心流程：

1. 按关键词检索 **Europe PMC** 最近几天的新文章；
2. 用 **D1**（SQLite）排除已推送过的文章；
3. 用 **Workers AI**（`@cf/meta/llama-3.1-8b-instruct-fast`，JSON Mode 结构化输出）按相关性、新颖性、证据强度、反直觉程度、实验启发五个维度评分；
4. 前端静态页面展示「为什么值得看、机制链、关键证据、主要疑点、最小判别实验」；
5. **Cron Trigger** 每天 05:00 UTC 自动运行。

项目文档（README、schema 中的注释、种子数据）主要使用**中文**，代码注释与新增文档应沿用中文；代码标识符保持英文。

## 仓库现状

仓库目前只包含配置与文档，**应用代码尚未提交**：

- 已存在：`package.json`、`wrangler.jsonc`、`schema.sql`、`README.md`、`LICENSE`、`.gitignore`
- README 描述了但**尚不存在**的目录：`src/index.js`（Worker 后端）、`public/`（`index.html`、`styles.css`、`app.js` 静态前端）

实现新代码时应以 `wrangler.jsonc` 和 `schema.sql` 作为权威契约（绑定名、表结构、字段名），并与 README 描述的行为保持一致。

## 技术栈与运行时架构

- **运行时**：Cloudflare Workers（`type: module`），无构建步骤，入口 `src/index.js`。
- **绑定**（定义在 `wrangler.jsonc`，后端通过 `env.*` 访问，不要改名）：
  - `env.DB` — D1 数据库（binding 名固定为 `DB`）；
  - `env.AI` — Workers AI（`remote: true`，本地开发也在 Cloudflare 远程运行并计费）；
  - `env.ASSETS` — 静态资源目录 `./public`；`/api/*` 由 Worker 优先处理（`run_worker_first`），其余路径回退到 SPA（`not_found_handling: "single-page-application"`）；
  - `env.AI_MODEL` — 环境变量，模型 ID。
- **计划任务**：`triggers.crons: ["0 5 * * *"]`（UTC），改后需重新部署。
- **秘密**：可选 `ADMIN_TOKEN`（`npx wrangler secret put ADMIN_TOKEN`），只保护保存配置与手动同步接口，读取简报是公开的。

## 常用命令

```bash
npm install                    # 唯一依赖是 wrangler（devDependencies）
npm run dev                    # 本地开发（wrangler dev，默认 http://localhost:8787）
npm run deploy                 # 部署（wrangler deploy）
npm run db:init:local          # 用 schema.sql 初始化本地 D1
npm run db:init:remote         # 初始化远程 D1
npm run db:show:local          # 查看 settings 表（本地）
npm run db:show:remote         # 查看 settings 表（远程）
```

本地测试 scheduled handler：

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
```

**没有测试框架、lint 或类型检查配置**，也没有 CI。验证方式是本地运行 `npm run dev` 并在浏览器/curl 中检查行为；前端另有 `?demo=1` 演示模式（假数据，不调用 Europe PMC / Workers AI / D1）。

## 数据库（schema.sql）

四张表，D1（SQLite），外键已开启：

- `settings` — 单行（`id = 1` CHECK 约束）：`query_groups`（JSON 数组字符串，每行一个必须满足的概念，`|` 分隔同义词）、`focus`（AI 研究者画像）、`exclude_terms`、`max_articles`（1–10）、`lookback_days`（1–30）、`exclude_reviews`、`enabled`。
- `digests` — 每次运行一条：`run_at`、`query_text`、候选/入选数量、`status`（`ok|empty|error|skipped`）。
- `articles` — 去重依据：`id` 主键、`pmid`、`pmcid`、`doi`、标题/摘要/期刊/日期/链接。
- `digest_items` — 简报与文章的多对多关联：五个维度分数 + `total`、`evidence_level`、五段解读文本；`ON DELETE CASCADE`。

改 schema 时同步更新 `schema.sql` 与 README；用 `db:init:local` / `db:init:remote` 应用。

## 代码组织与约定

按 README 的预期结构：

```text
src/index.js    # Worker：fetch（API + 资源）与 scheduled handler
public/         # 静态前端，无构建、无框架
```

预期约定（来自 README 与配置，实现时遵循）：

- 检索查询由 `query_groups` 构造：组内 `|` 同义词 OR，组间 AND。
- 日期窗口回看 4–7 天（重叠窗口防漏，索引日期与发表日期不同步），靠 D1 去重。
- Workers AI 使用 JSON Mode / JSON Schema 强制结构化输出；AI 输出失败时应记入 `digests.status = 'error'`。
- API 路由挂在 `/api/*` 下，其余交给静态资源/SPA。
- 前端是纯 HTML/CSS/JS（无构建工具、无 npm 前端依赖），响应式。

## 安全注意事项

- `wrangler.jsonc` 中的 `database_id` 是占位符 `REPLACE_WITH_YOUR_D1_DATABASE_ID`，部署前必须替换为 `wrangler d1 create oncopaper-radar` 返回的真实 ID。
- 不要把 `ADMIN_TOKEN` 写入代码或仓库；用 `wrangler secret put` 管理。`.dev.vars`、`.env` 已在 `.gitignore` 中。
- 不设令牌时任何人都能改配置/触发同步；公开部署必须设置。
- 「有趣」偏好（`focus`）是给 AI 的画像，**不要**放未公开患者信息、身份信息或敏感临床数据。
- AI 解读只基于标题、摘要与元数据——README 明确要求提醒用户关键结论须回原文核验。

## 已知边界（README 第 11 节）

未实现：邮件/Telegram/企业微信推送、👍/👎 反馈学习、PDF 全文解析、多用户、Vectorize 语义记忆、PubMed 与 bioRxiv 补充源。建议的下一步是邮件推送或反馈表。

## 官方参考

- Cloudflare Workers Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Workers AI bindings / JSON Mode: https://developers.cloudflare.com/workers-ai/
- D1: https://developers.cloudflare.com/d1/get-started/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Europe PMC REST API: https://europepmc.org/RestfulWebService
