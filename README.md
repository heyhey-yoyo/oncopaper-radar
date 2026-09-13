# OncoPaper Radar

肿瘤分子机制文献雷达，部署在 Cloudflare Workers 上，每日自动检索、AI 评分、生成个性化科研简报。

它会：

1. 按你的关键词同时检索 Europe PMC + PubMed，自动补全摘要并去重；
2. 查询按严格到宽松逐级降级，提高找到可用候选的机会；无匹配或外部服务异常时仍可能无结果；
3. 用 Workers AI 做两阶段评分（先打分、再写解读），AI 全挂也能规则兜底出简报；
4. 同步和画像生成跑在 Cloudflare Workflows 上，HTTP 请求立即返回，前端轮询进度；
5. Cron Trigger 每天 UTC 05:00 自动运行。

> 这是科研信息筛选工具，不是生物医学结论的最终裁判。AI 解读只依据标题、摘要与元数据，关键结论必须回到原文和原始数据核验。

## 主要功能

- Europe PMC + PubMed 双源检索，摘要互补
- 查询逐级降级（严格 → 宽松）；每轮候选最多 80 篇，不保证覆盖全部相关文献
- 论文别名表跨 PMID/PMCID/DOI/来源统一身份识别，已处理论文不重复评分
- 新论文优先排序，历史论文不占用候选名额导致空简报
- Workers AI 两阶段评分（评分 + 解读）
- 确定性规则回退（AI 全挂也能出简报）
- Cloudflare Workflows 后台任务 + 前端轮询
- 运行租约防止并发重复创建 Workflow
- 画像生成（PMID → AI 推断检索概念）
- 去重缓存（同一画像不重复评分）
- D1 运行时自动迁移
- Cron 每日同步
- 可选 NCBI API Key
- 响应式网页与安全响应头

## 界面风格

采用暖米白、浅灰与赤陶色，衬线标题与系统无衬线正文保持统一层级，图表与状态提示保留必要的颜色区别。

页眉内容区居中，品牌与标题靠左，操作靠右；页眉位于文档顶部，随页面正常滚走，窄屏允许换行。页眉背景与分隔线铺满页面宽度。

同步与画像生成各自显示进度，长标题可换行，任务结束后恢复操作。

## 数据与隐私

检索关键词、研究偏好、评分结果与每日简报保存在你自己的 Cloudflare D1 数据库中。执行检索时，查询词会发送给 Europe PMC 和 NCBI；Workers AI 评分请求包含研究偏好、论文标题、摘要与元数据。请勿在关键词或研究偏好中输入私人或敏感信息。

管理令牌仅保存在当前浏览器会话（`sessionStorage`），关闭标签页通常清除本地保存值；凭证本身持续有效，直到部署者更换管理员口令。工具无账户注册系统；自有数据库存储不代表数据从不发送给上述外部服务。

最新一次成功筛选的论文、评分及 AI 解读可被任何访问者读取；请勿将本站视为私有研究结果空间。设置与完整历史记录需要管理员口令。部分文献来源故障时，结果会标明检索不完整；没有可用新论文时明确显示未完成，而不推断没有新文献。公开接口不返回内部错误细节。

## 本地运行

需要：

- 一个 Cloudflare 账户
- Node.js 22 或更高版本（wrangler 4.x 要求）
- 能运行终端命令

```bash
cd oncopaper-radar
npm ci
npm run db:init:local
npm run dev
```

开发服务器默认运行在 `http://localhost:8787`。

`package-lock.json` 固定稳定版 Wrangler 与已审计的间接依赖。安装或修复依赖时不要使用 `npm audit fix --force` 或预发布版本。

## 部署

对外版本以 GitHub Release 为准；应用版本由项目依赖清单维护，发布时同步更新。内部数据格式和算法机制版本独立演进。

1. 登录并创建 D1 数据库：

```bash
npm exec -- wrangler login
npx wrangler d1 create oncopaper-radar
```

命令会返回 `database_id`，打开 `wrangler.jsonc`，将 `d1_databases[0].database_id` 替换为返回的真实 ID。不要改绑定名 `DB`。

2. 初始化远程数据库：

```bash
npm run db:init:remote
```

3. 设置管理员令牌（必须，未配置时所有管理 API 返回 503）：

```bash
npm exec -- wrangler secret put ADMIN_TOKEN
```

4. 部署：

```bash
npm run deploy
```

部署时会自动创建 Cloudflare Workflows 绑定（`RADAR_WORKFLOW`），无需手动配置。日常迭代推送 `main` 分支即可经 Cloudflare Git 集成自动构建部署；本节手动步骤用于首次创建资源与排障。

可选：设置 NCBI API Key 以提高 PubMed 请求额度：

```bash
npm exec -- wrangler secret put NCBI_API_KEY
```

部署后在网址后加 `?demo=1` 可进入演示模式，使用假数据、不调用外部 API 或 AI。

## 责任边界

这是科研信息筛选工具，不是生物医学结论的最终裁判。AI 解读只依据标题、摘要与元数据，关键结论必须回到原文和原始数据核验。

## License

MIT

---

> AI 编程代理请阅读 [AGENTS.md](./AGENTS.md) 了解代码架构、测试与开发约定。

---

## AI 维护提醒

> **⚠️ 任何修改此项目的 AI 代理（Claude Code、Cursor、Copilot 等）都必须同步更新本文件与 AGENTS.md。**
>
> - 新增功能 → 在 README 中添加用户可理解的说明
> - 新增/删除文件 → 更新 AGENTS.md 中的文件清单
> - 修改架构 → 更新 AGENTS.md 的架构说明
> - 部署方式变更 → 同步更新本文部署章节
> - 保持 README 面向人类用户，AGENTS.md 面向 AI 代理，两份文件不可互相替代
