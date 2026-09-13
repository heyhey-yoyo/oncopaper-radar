# OncoPaper Radar — 项目说明（供 AI 编程代理阅读）

本文件供 AI 编码代理阅读，描述 OncoPaper Radar 项目的架构、命令与约定。

## 项目概览

OncoPaper Radar 是一个部署在 Cloudflare Workers 上的个人科研文献雷达，面向肿瘤分子机制研究。核心流程：

1. 按关键词同时检索 Europe PMC + PubMed，自动补全摘要并去重；
2. 查询按严格到宽松逐级降级，部分来源失败且无可用新候选时报告未完成；有候选时标记检索不完整；
3. 用 Workers AI（Qwen3-30B-A3B 优先，Granite 4.0 H Micro 兜底）做两阶段评分（先打分数、再写解读）；
4. AI 全挂时自动回退到确定性规则引擎（关键词匹配 + 标题规则）；
5. 同步和画像生成跑在 Cloudflare Workflows 上，HTTP 请求立即返回任务 ID，前端短轮询进度；
6. Cron Trigger 每天 05:00 UTC 自动运行；
7. 去重缓存：同一画像 + 同一 prompt 版本不重复评分同一篇论文。

项目文档（README、schema、注释）主要使用中文，代码注释与新增文档沿用中文；代码标识符保持英文。

## 技术栈与运行架构

- 运行时：Cloudflare Workers（`type: module`），无构建步骤，入口 `src/index.js`
- Cloudflare Workflows：`RadarWorkflow` 类（`src/index.js`）继承 `WorkflowEntrypoint`，处理 sync 和 profile 两类任务；引擎在 `wrangler.jsonc` 中通过 `workflows` 配置绑定为 `RADAR_WORKFLOW`
- 绑定（通过 `env.*` 访问，不要改名）：`env.DB`（D1）、`env.AI`（Workers AI）、`env.ASSETS`（静态资源 `./public`）、`env.RADAR_WORKFLOW`（Workflows）
- `env.ASSETS` 所有路径由 Worker 优先处理（`run_worker_first: ["/*"]`），Worker 内部对非 `/api/*` 请求回退到静态资源（serveAssets）
- Secrets：`ADMIN_TOKEN`（必须设置，否则管理 API 返回 503）、`NCBI_API_KEY`（可选，提高 PubMed 请求额度）
- Cron：`triggers.crons: ["0 5 * * *"]`（UTC），改后需重新部署

## 项目结构

| 文件 | 作用 |
| --- | --- |
| `src/index.js` | Worker 入口、API 路由、RadarWorkflow 定义、候选预排序 |
| `src/ai.js` | AI 调用封装、两阶段评分、规则回退（heuristicScore/fallbackProfile/fallbackAnalysis） |
| `src/radar.js` | 论文身份识别、别名生成、多源去重合并、分层探测引擎与公开简报脱敏投影 |
| `src/query.js` | 检索词清洗、Europe PMC / PubMed 查询构造 |
| `src/search.js` | 文献检索：分层查询、双源抓取、PMID 补全、身份解析 |
| `src/storage.js` | D1 持久化：运行记录/租约、候选元数据、处理决策、简报 |
| `src/migrate.js` | D1 运行时迁移（ensureSchema → migrateSchema） |
| `src/utils.js` | 共享工具：cleanText/cleanTerm/clampInt/chunk/safeParse/friendlyError/HttpError/D1_BIND_CHUNK |
| `public/index.html` | 静态页面（不动 HTML 结构和 CSS 就不会影响前端显示） |
| `public/styles.css` | 样式 |
| `public/app.js` | 前端逻辑：短轮询工作流状态、设置表单、简报渲染、失败状态布局 |
| `test/ai.test.js` | 启发式评分边界、画像降级测试 |
| `test/query.test.js` | 查询构造、术语清洗回归测试 |
| `test/radar.test.js` | 论文身份、候选截断、别名兼容回归测试 |
| `test/search-network.test.js` | 外部请求超时、网络错误、429/5xx 有限重试及不可重试状态回归 |
| `schema.sql` | D1 建表 SQL（`db:init:local` / `db:init:remote` 使用） |
| `wrangler.jsonc` | Worker 配置（D1 / AI / ASSETS / Workflows 绑定、Cron、`run_worker_first`） |
| `public/project-mark.svg` | 项目专属标志（favicon） |
| `package.json` / `package-lock.json` | npm 脚本与锁定依赖 |
| `CHANGED_FILES.md` / `UPGRADE.md` / `VALIDATION.md` | 变更记录、升级说明与验收记录 |
| `LICENSE` | MIT 许可证 |

## 运行与构建

```bash
npm ci                         # 唯一依赖是锁定版本的 wrangler（devDependencies）
npm run dev                    # 本地开发（wrangler dev，默认 http://localhost:8787）
npm run deploy                 # 部署（wrangler deploy）
npm run check                  # 语法检查（node --check 所有 JS 文件）
npm test                       # 运行测试（node --test）
npm run db:init:local          # 用 schema.sql 初始化本地 D1
npm run db:init:remote         # 初始化远程 D1
npm run db:show:local          # 查看 settings 表（本地）
npm run db:show:remote         # 查看 settings 表（远程）
```

`package-lock.json` 是 Worker 工具的可复现与安全基线；保持稳定 Wrangler 和已审计的间接依赖覆盖，不使用 `npm audit fix --force` 或预发布版本。

## 测试

`npm test`（`node --test`）覆盖 AI 评分边界与故障降级（`ai.test.js`）、查询构造回归（`query.test.js`）、论文身份与候选截断及别名兼容回归（`radar.test.js`）、外部请求超时/有限重试与部分来源失败不可误报为空（`search-network.test.js`）；公开简报不回显内部错误详情。

发布检查：

```bash
npm run check
npm test
```

## 代码组织与风格约定

### AI 模型配置（`src/ai.js`）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `QWEN` | `@cf/qwen/qwen3-30b-a3b-fp8` | 主力模型 |
| `GRANITE` | `@cf/ibm-granite/granite-4.0-h-micro` | 兜底模型 |
| `PROFILE_CHAIN` | `[QWEN, GRANITE]` | 画像生成模型链 |
| `SCORE_CHAIN` | `[QWEN, GRANITE]` | 评分模型链 |
| `PROMPT_VERSION` | `2026-07-30-v3` | 升版号可强制重新评分所有论文 |

更换模型时修改 `src/ai.js` 的实际模型 ID 常量 `QWEN` / `GRANITE`，按需调整 `PROFILE_CHAIN` / `SCORE_CHAIN`，并同步 `MODEL_LABELS` 的显示名称。仅改标签不会替换推理模型；核对真实 AI 调用与 `src/index.js` 的 `handleModelInfo()` 返回值一致。

Token 配置：`runAIForJSON` 的 `maxTokens` 通过 `clampInt` 限制在 128–3000。评分阶段用 700 token（只输出分数），解读阶段用 2500 token（输出中文解读）。每个模型调用有 `withTimeout` 等待期限；超时不会取消已提交的 AI 绑定调用。

### 论文身份识别（`src/radar.js`）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `PROCESSING_VERSION` | `2026-07-31-v2` | 处理指纹版本，升版可强制重新处理所有候选 |

核心导出：`articleIdentityAliases`、`preferredCanonicalId`（PMID > PMCID > DOI > 来源型 ID）、`mergeArticlesByIdentity`、`shareArticleIdentity`、`probeTiersUntilUsable`（分层探测引擎）、`processingFingerprintPayload`。

### 数据库（`schema.sql` + 运行时迁移）

八张表，D1（SQLite），外键已开启：`settings`、`digests`、`articles`、`digest_items`、`sync_runs`、`processed_articles`、`article_aliases`、`run_leases`。

运行时迁移（`ensureSchema` → `migrateSchema`）：`CREATE TABLE IF NOT EXISTS` 处理新表，`PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 处理已有表新列，幂等执行，部署即升级，无需手动跑 SQL。别名迁移（`INSERT OR IGNORE INTO article_aliases`）仅新增别名，不删除、不重写、不自动合并历史记录。

### 关键设计决策

- 两阶段评分（`scorePapers`）：ranking 只输出 5 个整数分数（700 token）；enrichment 仅对入选论文输出中文解读（2500 token）。两个阶段有各自等待预算和规则回退；ranking 不可用时跳过 enrichment。
- 确定性回退：`heuristicScore()`、`fallbackProfile()`、`fallbackAnalysis()`。
- 查询降级（`buildQueryTiers`）：strict → without-optional → required-without-negative-terms → relaxed-required → single-core-without-negative-terms。
- D1 分块：所有带 `IN (...)` 的查询使用 `D1_BIND_CHUNK = 30` 分块。
- 候选截断顺序：先按「新论文优先、历史论文垫后」排序，再 `.slice(0, MAX_CANDIDATES)`。
- Workflow 运行租约：`run_leases` 表以 `run_type` 为主键，`claimWorkflowSlot()` 先申请租约再创建 Workflow，`releaseRunLease()` 在完成或失败后释放。

### Workflow 步骤

| 步骤 | 配置 | 内容 |
| --- | --- | --- |
| search-literature | retries 3, timeout 5min | Europe PMC + PubMed 双源搜索，写入候选元数据 |
| prepare-candidates | 默认 | 去重、规则预排序 |
| score-papers | retries 1, timeout 10min | AI 两阶段评分 |
| store-digest | 默认 | 存储简报和处理决策 |

### API 路由

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/auth/check` | 需要 | 验证令牌 |
| GET | `/api/settings` | 需要 | 读取设置 |
| POST | `/api/settings` | 需要 | 保存设置 |
| POST | `/api/sync` | 需要 | 启动同步 Workflow |
| POST | `/api/generate-profile` | 需要 | 启动画像 Workflow |
| GET | `/api/runs/active` | 需要 | 获取当前活跃 run |
| GET | `/api/runs/:id` | 需要 | 获取指定 run 状态 |
| GET | `/api/digests` | 需要 | 简报列表 |
| GET | `/api/digests/latest` | 公开 | 最新简报 + 入选文章及评分/解读，匿名可读 |
| GET | `/api/model-info` | 公开 | 模型信息（静态） |

### 前端约定

- 纯 HTML/CSS/JS，无框架，无构建工具
- `esc()` 对所有用户/API 数据渲染做转义
- `api()` helper 统一处理认证头、超时、错误格式化
- 保存的 token 存 `sessionStorage`（关标签页通常清除本地副本，服务端 `ADMIN_TOKEN` 需轮换才失效）
- 不改 `index.html` 和 `styles.css` 的情况下可以单独更新 `app.js`
- 轮询间隔 2 秒，最多 600 次（20 分钟），超出提示用户关页面稍后重连

### 品牌与排版

本项目为 Tools 工具类。页眉桌面 72px、手机（≤640px）64px；YDchen 为衬线 20px/600，Tools 为无衬线 20px/300，手机字标 18px；标题 18px/600、手机 16px；分隔线 36px/32px，品牌、分隔线与标题间距 16px/12px。

页眉背景和底部分隔线横跨页面可用宽度，内容区最大宽度 1280px（含两侧各 16px 内边距），整体居中；品牌和标题靠左，操作区靠右，窄屏换行后仍保持该对齐。品牌页眉在文档顶部正常排布，随页面滚走，不固定或吸顶；表格内部表头、侧边工具和手机底部导航可按功能保留。

正文采用统一系统无衬线字体，默认 16px / 1.6；标题采用 Georgia、Times New Roman、Songti SC、STSong 衬线族。数字与代码可使用 SFMono-Regular、Consolas、Liberation Mono、Microsoft YaHei 等宽族。按钮和输入通常 15px，辅助文字 12–14px，密集科学数据允许有理由的局部调整。页面底色 #f3eee5、正文 #24221f、赤陶强调 #a94f31，柔和底色上的强调文字 #823a25；科学分类色、热图、作品主题与状态色保留必要区分度。

主样式保留一个顶层 `:root`，条件规则和深色画布局部令牌独立维护，避免叠加重复主题或末尾覆盖层。修改视觉后核对实际渲染字体、字号、间距、对比度和操作可达性；至少检查 1440、820、390px，涉及断点时补查两侧宽度，涉及画布或存储时补查交互。构建、单测、本地浏览器和线上部署分别记录；发布后禁用缓存/硬刷新，并核对实际资源版本。

### 交互与数据约束

syncProgress 与 profileProgress 独立、可被辅助技术读取，进度范围 0–100，结束后清理。外部检索设置 15 秒 AbortSignal，最多尝试三次；400 不重试，暂时性 503 可恢复。

### 界面维护约定

正文使用 `ydchen-portfolio` 的米白 / 赤陶色视觉系统；`YDchen Tools` 页眉是受保护的品牌区域，后续调整不得改变其结构与样式，API、评分和轮询语义也必须保持不变。

## 部署

对外版本以 GitHub Release 为准；应用版本源为根目录 `package.json`，发布时用 `npm install --package-lock-only` 同步 `package-lock.json`。内部数据格式、模型及提示词版本独立演进，不随应用发布机械递增。

- Cloudflare Workers：`wrangler.jsonc` 声明 D1（`DB`）、Workers AI（`AI`）、静态资源（`ASSETS`，`run_worker_first: ["/*"]`）与 Workflows（`RADAR_WORKFLOW`）绑定；`npm run deploy` 部署，Workflows 绑定自动创建。
- D1 首次需 `wrangler d1 create oncopaper-radar` 并回填 `database_id`；schema 由 `schema.sql` 初始化（`db:init:local` / `db:init:remote`），运行时迁移自动升级。
- Secrets：`ADMIN_TOKEN`（必须，未设置时管理 API 返回 503）、`NCBI_API_KEY`（可选），均通过 `wrangler secret put` 设置，不写入仓库。
- Cron `0 5 * * *`（UTC）与绑定变更需重新部署后生效。
- 日常迭代推送 `main` 分支经 Cloudflare Git 集成自动构建部署。

## 安全与数据注意事项

- `ADMIN_TOKEN` 必须通过 `wrangler secret put` 设置，不设则管理 API 全部 503；不把 token 写入代码或提交仓库
- `esc()` 函数处理所有前端动态内容渲染，`safeHref()` 校验 URL 协议
- D1 查询全部参数化（`.bind()`），SQL 无拼接
- CORS 仅允许同源请求
- 安全响应头：`X-Frame-Options: DENY`、`Content-Security-Policy`（default-src 'self'）
- 公开 `src/radar.js` 的 `publicDigest()` 只输出固定状态文案或 `PARTIAL_SOURCES` 通用提示；详细错误保留鉴权任务/历史记录和日志。`friendlyError()` 的截断不视为保密保证
- 管理令牌比较使用 `constantTimeEqual()` 常量时间比较，避免时序侧信道

## 标志维护约定

`YDchen Tools` 文字页眉是受保护的品牌区域，必须保持原结构、尺寸与样式；项目专属统一标志 `public/project-mark.svg` 仅用于 favicon 或现有非页眉标志，不得改变页面布局。

---

## AI 维护提醒

> **⚠️ 任何修改此项目的 AI 代理（包括未来的你自己）都必须遵守：**
>
> - 修改代码后必须同步更新本 AGENTS.md 与 [README.md](./README.md)——新增文件、架构变更、功能增删、部署方式变更都需要在两份文档中体现
> - [README.md](./README.md) 面向人类用户（功能介绍、运行方法、部署步骤），AGENTS.md 面向 AI 代理（架构、代码组织、测试策略、开发约定）
> - 两份文件不可互相替代，各有所长
> - 项目的实际文件结构必须与 AGENTS.md 中列出的文件清单保持一致
