# OncoPaper Radar

肿瘤分子机制文献雷达 — 部署在 Cloudflare Workers 上，每日自动检索、AI 评分、生成个性化科研简报。

它会：

1. 按你的关键词同时检索 **Europe PMC + PubMed**，自动补全摘要并去重；
2. 查询按**严格到宽松逐级降级**，不会因为查不到就返回空；
3. 用 Workers AI 做**两阶段评分**（先打分、再写解读），AI 全挂也能规则兜底出简报；
4. 同步和画像生成跑在 **Cloudflare Workflows** 上，HTTP 请求立即返回，前端轮询进度；
5. **Cron Trigger** 每天 UTC 05:00 自动运行。

> 这是科研信息筛选工具，不是生物医学结论的最终裁判。AI 解读只依据标题、摘要与元数据，关键结论必须回到原文和原始数据核验。

## 界面风格

正文采用 `ydchen-portfolio` 的暖米白、浅灰与赤陶色视觉系统，使用衬线标题和扁平化信息卡片；`YDchen Tools` 页眉结构与样式保持不变。

---

## 目录

```text
oncopaper-radar/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ src/
│  ├─ index.js          # Worker 入口、API 路由、Workflow 定义
│  ├─ ai.js             # AI 调用、两阶段评分、规则回退
│  ├─ radar.js          # 论文身份识别、别名、去重合并、分层探测
│  ├─ query.js          # 检索词清洗、Europe PMC/PubMed 查询构造
│  ├─ search.js         # 文献检索、双源抓取、身份解析
│  ├─ storage.js        # D1 持久化（运行记录、简报、处理决策）
│  ├─ migrate.js        # D1 运行时迁移
│  └─ utils.js          # 共享工具函数
├─ test/
│  ├─ ai.test.js        # AI 评分边界与故障降级测试
│  ├─ query.test.js     # 查询构造回归测试
│  └─ radar.test.js     # 论文身份、候选截断、别名兼容回归测试
├─ package.json
├─ schema.sql
└─ wrangler.jsonc
```

## Demo 模式

在部署后的网址后加 `?demo=1`：

```text
https://你的项目.workers.dev/?demo=1
```

演示模式使用假数据，不调用外部 API 或 AI。

---

## 准备环境

需要：

- 一个 Cloudflare 账户；
- Node.js 22 或更高版本（wrangler 4.x 要求）；
- 能运行终端命令。

```bash
cd oncopaper-radar
npm install
npx wrangler login
```

---

## 创建 D1 数据库

```bash
npx wrangler d1 create oncopaper-radar
```

命令会返回类似：

```json
{
  "binding": "DB",
  "database_name": "oncopaper-radar",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

打开 `wrangler.jsonc`，将 `d1_databases[0].database_id` 替换为返回的真实 ID。

> 不要改绑定名 `DB`，后端代码通过 `env.DB` 访问数据库。

---

## 初始化远程数据库

```bash
npm run db:init:remote
```

> 新版代码包含运行时迁移，后续部署不需要再手动执行 SQL。但首次使用仍需初始化。

---

## 必须设置管理员令牌

新版**要求**设置令牌，未配置时所有管理 API 返回 503：

```bash
npx wrangler secret put ADMIN_TOKEN
```

输入一串你自己生成的长随机字符串。部署后点击网页右上角登录按钮，填入同一个字符串。

可选：设置 NCBI API Key 以提高 PubMed 请求额度：

```bash
npx wrangler secret put NCBI_API_KEY
```

---

## 部署

```bash
npm run deploy
```

部署时会自动创建 Cloudflare Workflows 绑定（`RADAR_WORKFLOW`），无需手动配置。

---

## 关键词怎么写

"检索概念"采用：

- 每行一个概念组，组与组之间是 AND；
- 同一行用 `|`（全角 `｜` 同样有效）分隔同义词，都表示 OR。

例如：

```text
KRAS G12D | KRASG12D
pancreatic cancer | pancreatic ductal adenocarcinoma | PDAC
ferroptosis | lipid peroxidation
```

系统会按**严格到宽松**逐级降级查询——先跑完整关键词组合，如果结果不够，自动去掉可选组、去掉排除词、放宽到核心组，确保不会漏文章。候选文章通过别名表（`article_aliases`）跨 PMID/PMCID/DOI/来源统一身份识别，已处理论文不会重复评分。

---

## 研究者画像怎么写

这是给 AI 的偏好描述，影响论文评分倾向。例如：

```text
优先原创机制研究；关注遗传学证据、rescue、催化失活突变体、
时间序列、体内模型和患者样本；喜欢与既有认识矛盾或可直接启发实验的结果；
降低纯生信预后模型、只有相关性表达分析和没有功能验证文章的评分。
```

也可以粘贴你感兴趣的论文 PMID，让 AI 从论文中自动推断画像。

---

## AI 模型与回退策略

| 模型 | 用途 |
| --- | --- |
| **Qwen3-30B-A3B** | 主力：评分 + 解读 + 画像 |
| **Granite 4.0 H Micro** | 兜底：Qwen 超时或不可用时接替 |
| **Heuristic fallback** | 终极兜底：关键词匹配，纯规则评分 |

AI 调用有硬超时保护，两阶段评分（先打分数再写解读），即使所有 AI 模型都不可用也能出简报。

---

## 自动运行

`wrangler.jsonc` 配置：

```json
"triggers": {
  "crons": ["0 5 * * *"]
}
```

每天 **05:00 UTC** 执行。需要修改时编辑 cron 表达式后重新部署。

---

## 本地开发

```bash
npm run db:init:local    # 初始化本地 D1
npm run dev               # 启动开发服务器（默认 http://localhost:8787）
npm run check             # 语法检查
npm test                  # 运行测试
```

---

## 常见问题

**页面提示 D1 尚未初始化**

确认 `wrangler.jsonc` 已替换正确的 `database_id`，且 `npm run db:init:remote` 已执行。

**管理员令牌不正确**

```bash
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

然后清除网页中的旧令牌，再输入新令牌。

**一篇文章都没有**

先尝试：减少检索概念行数、把回看窗口改成 14 天、删除过于具体的概念、在 Europe PMC 网站上验证检索词。

"All matching papers were already processed" 表示论文都已评过，等新论文出现或修改画像/检索词即可获得新简报。

**AI 同步报错**

可能原因：Workers AI 当日免费额度用完、模型临时不可用。系统会自动回退到规则评分，不会丢数据。查看 Cloudflare 控制台 Worker Logs 了解详情。

---

## 当前实现状态

已实现：

- Europe PMC + PubMed 双源检索，摘要互补；
- 查询逐级降级（严格 → 宽松）；
- 论文别名表（`article_aliases`）跨 PMID/PMCID/DOI/来源统一身份识别；
- 新论文优先排序，历史论文不占用候选名额导致空简报；
- Workers AI 两阶段评分（评分 + 解读）；
- 确定性规则回退（AI 全挂也能出简报）；
- Cloudflare Workflows 后台任务 + 前端轮询；
- 运行租约（`run_leases`）防止并发重复创建 Workflow；
- 画像生成（PMID → AI 推断检索概念）；
- 去重缓存（同一画像不重复评分）；
- D1 运行时自动迁移；
- Cron 每日同步；
- 可选 NCBI API Key；
- 响应式网页；
- 安全响应头（CSP、X-Frame-Options）。

暂未实现：

- 邮件、Telegram、企业微信推送；
- 点赞 / 不感兴趣反馈学习；
- PDF 全文解析；
- 多用户账号；
- Vectorize 语义记忆。

---

## 官方参考

- Cloudflare Workers Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Cloudflare Workflows: https://developers.cloudflare.com/workflows/
- Workers AI bindings: https://developers.cloudflare.com/workers-ai/configuration/bindings/
- D1: https://developers.cloudflare.com/d1/get-started/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Europe PMC REST API: https://europepmc.org/RestfulWebService
- PubMed E-utilities: https://www.ncbi.nlm.nih.gov/books/NBK25501/

---

> AI 编程代理请阅读 [AGENTS.md](./AGENTS.md) 了解代码架构、测试策略与开发约定。

---

## AI 维护提醒

> **⚠️ 任何修改此项目的 AI 代理（Claude Code、Cursor、Copilot 等）都必须同步更新本文件与 AGENTS.md。**
>
> - 新增功能 → 在 README 中添加用户可理解的说明
> - 新增/删除文件 → 更新本文和 AGENTS.md 中的文件清单
> - 修改架构 → 更新 AGENTS.md 的架构说明
> - 部署方式变更 → 同步更新本文部署章节
> - 保持 **README 面向人类用户**，**AGENTS.md 面向 AI 代理**，两份文件不可互相替代


## 项目标志

浏览器标题栏使用统一系列的项目专属 `project-mark.svg`。页面中的 `YDchen Tools` 文字页眉保持原有结构、尺寸与样式，不使用项目标志替换。
