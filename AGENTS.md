# AGENTS.md

本文件供 AI 编码代理阅读，描述 OncoPaper Radar 项目的架构、命令与约定。

## 项目概述

OncoPaper Radar 是一个部署在 **Cloudflare Workers** 上的个人科研文献雷达，面向肿瘤分子机制研究。核心流程：

1. 按关键词同时检索 **Europe PMC + PubMed**，自动补全摘要并去重；
2. 查询按**严格到宽松逐级降级**，不会因查不到而误报空结果；
3. 用 **Workers AI**（Qwen3-30B-A3B 优先，Granite 4.0 H Micro 兜底）做**两阶段评分**（先打分数、再写解读）；
4. AI 全挂时自动回退到**确定性规则引擎**（关键词匹配 + 标题规则）；
5. 同步和画像生成跑在 **Cloudflare Workflows** 上，HTTP 请求立即返回任务 ID，前端短轮询进度；
6. **Cron Trigger** 每天 05:00 UTC 自动运行；
7. 去重缓存 — 同一画像 + 同一 prompt 版本不重复评分同一篇论文。

项目文档（README、schema、注释）主要使用**中文**，代码注释与新增文档沿用中文；代码标识符保持英文。

## 文件结构

```text
src/
├─ index.js      # Worker 入口、API 路由、RadarWorkflow 定义、D1 运行时迁移
├─ ai.js         # AI 调用封装、两阶段评分、规则回退（heuristicScore/fallbackProfile/fallbackAnalysis）
└─ query.js      # 检索词清洗、Europe PMC / PubMed 查询构造
public/
├─ index.html    # 静态页面（不动 HTML 结构和 CSS 就不会影响前端显示）
├─ styles.css    # 样式
└─ app.js        # 前端逻辑：短轮询工作流状态、设置表单、简报渲染
test/
├─ ai.test.js    # 启发式评分边界、画像降级测试
└─ query.test.js # 查询构造、术语清洗回归测试
```

## 技术栈与运行时架构

- **运行时**：Cloudflare Workers（`type: module`），无构建步骤，入口 `src/index.js`。
- **Cloudflare Workflows**：`RadarWorkflow` 类（`src/index.js`）继承 `WorkflowEntrypoint`，处理 sync 和 profile 两类任务。引擎在 `wrangler.jsonc` 中通过 `workflows` 配置绑定为 `RADAR_WORKFLOW`。
- **绑定**（通过 `env.*` 访问，不要改名）：
  - `env.DB` — D1 数据库；
  - `env.AI` — Workers AI；
  - `env.ASSETS` — 静态资源目录 `./public`；`/api/*` 由 Worker 优先处理（`run_worker_first`），其余回退到 SPA；
  - `env.RADAR_WORKFLOW` — Cloudflare Workflows 绑定，用于创建后台任务。
- **Secrets**：`ADMIN_TOKEN`（**必须设置**，否则管理 API 返回 503）、`NCBI_API_KEY`（可选，提高 PubMed 请求额度）。
- **Cron**：`triggers.crons: ["0 5 * * *"]`（UTC），改后需重新部署。

## 常用命令

```bash
npm install                    # 唯一依赖是 wrangler（devDependencies）
npm run dev                    # 本地开发（wrangler dev，默认 http://localhost:8787）
npm run deploy                 # 部署（wrangler deploy）
npm run check                  # 语法检查（node --check 所有 JS 文件）
npm test                       # 运行测试（node --test）
npm run db:init:local          # 用 schema.sql 初始化本地 D1
npm run db:init:remote         # 初始化远程 D1
npm run db:show:local          # 查看 settings 表（本地）
npm run db:show:remote         # 查看 settings 表（远程）
```

## AI 模型配置（`src/ai.js`）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `QWEN` | `@cf/qwen/qwen3-30b-a3b-fp8` | 主力模型 |
| `GRANITE` | `@cf/ibm-granite/granite-4.0-h-micro` | 兜底模型 |
| `PROFILE_CHAIN` | `[QWEN, GRANITE]` | 画像生成模型链 |
| `SCORE_CHAIN` | `[QWEN, GRANITE]` | 评分模型链 |
| `PROMPT_VERSION` | `2026-07-30-v3` | 升版号可强制重新评分所有论文 |

改模型时**同步更新**以下两处：
- `MODEL_LABELS` 常量（`src/ai.js:14`）— 模型 ID → 显示名映射；
- `handleModelInfo()` 函数（`src/index.js:415`）— 前端 AI Provider 展示。

**Token 配置**：`runAIForJSON` 的 `maxTokens` 通过 `clampInt` 限制在 128–3000。评分阶段用 700 token（只输出分数），解读阶段用 2500 token（输出中文解读）。每个模型调用有 `withTimeout` 硬超时保护。

## 数据库（`schema.sql` + 运行时迁移）

六张表，D1（SQLite），外键已开启：

- `settings` — 单行（`id = 1` CHECK 约束）：检索配置、画像、生成计划。
- `digests` — 每次运行一条记录，关联 `run_id` 到 `sync_runs`。
- `articles` — 去重依据：`id` 主键、`pmid`、`doi`、标题/摘要等。
- `digest_items` — 简报与文章的关联表，五个维度分数 + 解读文本；`ON DELETE CASCADE`。
- `sync_runs` — Workflow 运行状态：类型、进度、阶段、结果。
- `processed_articles` — 去重缓存：以 `canonical_id` 为主键，按 `profile_hash + prompt_version` 判断是否已处理。

运行时迁移（`ensureSchema` → `migrateSchema`）：
- `CREATE TABLE IF NOT EXISTS` 处理新表；
- `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 处理已有表的新列；
- 幂等执行，部署即升级，无需手动跑 SQL。

## 关键设计决策

### 两阶段评分（`scorePapers`）
1. **ranking**：AI 只输出每篇论文的 5 个整数分数（700 token），不写文字；
2. **enrichment**：仅对入选论文输出中文解读（2500 token）。

两个阶段独立超时，独立 fallback。评分失败 → 规则分数；解读失败 → 模板文本。

### 确定性回退
- `heuristicScore()` — 关键词匹配 + 模式正则打分；
- `fallbackProfile()` — 从标题提取疾病名和靶点构建检索概念；
- `fallbackAnalysis()` — 模板化解读文本。

### 查询降级（`buildQueryTiers`）
strict（全部概念组）→ without-optional → required-without-negative-terms → relaxed-required → single-core-without-negative-terms。优先用 count 预检，count 不可用时直接跑搜索。

### D1 分块
所有带 `IN (...)` 的 D1 查询使用 `D1_BIND_CHUNK = 30` 分块，避免超过 SQLite 绑定变量上限。

### Workflow 步骤
| 步骤 | 配置 | 内容 |
| --- | --- | --- |
| search-literature | retries 3, timeout 5min | Europe PMC + PubMed 双源搜索，写入候选元数据 |
| prepare-candidates | 默认 | 去重、规则预排序 |
| score-papers | retries 1, timeout 10min | AI 两阶段评分 |
| store-digest | 默认 | 存储简报和处理决策 |

## API 路由

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- |------|
| GET | `/api/auth/check` | 需要 | 验证令牌 |
| GET | `/api/settings` | 公开 | 读取设置 |
| POST | `/api/settings` | 需要 | 保存设置 |
| POST | `/api/sync` | 需要 | 启动同步 Workflow |
| POST | `/api/generate-profile` | 需要 | 启动画像 Workflow |
| GET | `/api/runs/active` | 需要 | 获取当前活跃 run |
| GET | `/api/runs/:id` | 需要 | 获取指定 run 状态 |
| GET | `/api/digests` | 公开 | 简报列表 |
| GET | `/api/digests/latest` | 公开 | 最新简报 + 入选文章 |
| GET | `/api/model-info` | 公开 | 模型信息（静态） |

## 安全约定

- `ADMIN_TOKEN` 必须通过 `wrangler secret put` 设置，**不设则管理 API 全部 503**。
- 不把 token 写入代码或提交仓库。
- `esc()` 函数处理所有前端动态内容渲染，`safeHref()` 校验 URL 协议。
- D1 查询全部参数化（`.bind()`），SQL 无拼接。
- CORS 仅允许同源请求。
- 错误信息经过 `friendlyError()` 脱敏（截断 + 替换错误码）。

## 前端约定

- 纯 HTML/CSS/JS，无框架，无构建工具。
- `esc()` 对所有用户/API 数据渲染做转义。
- `api()` helper 统一处理认证头、超时、错误格式化。
- 保存的 token 存 `localStorage`。
- 不改 `index.html` 和 `styles.css` 的情况下可以单独更新 `app.js`。
- 轮询间隔 2 秒，最多 600 次（20 分钟），超出提示用户关页面稍后重连。

---

## AI 维护提醒

> **⚠️ 任何修改此项目的 AI 代理（包括未来的你自己）都必须遵守：**
>
> - **修改代码后必须同步更新本 AGENTS.md 与 README.md** — 新增文件、架构变更、功能增删、部署方式变更都需要在两份文档中体现
> - README.md 面向**人类用户**（功能介绍、运行方法、部署步骤），AGENTS.md 面向 **AI 代理**（架构、代码组织、测试策略、开发约定）
> - 两份文件**不可互相替代**，各有所众
> - 项目的实际文件结构必须与 AGENTS.md 中列出的文件清单保持一致
