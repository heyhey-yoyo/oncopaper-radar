# OncoPaper Radar

肿瘤分子机制文献雷达，部署在 Cloudflare Workers 上，每日自动检索、AI 评分、生成个性化科研简报。

它会：

1. 按你的关键词同时检索 Europe PMC + PubMed，自动补全摘要并去重；
2. 查询按严格到宽松逐级降级，不会因为查不到就返回空；
3. 用 Workers AI 做两阶段评分（先打分、再写解读），AI 全挂也能规则兜底出简报；
4. 同步和画像生成跑在 Cloudflare Workflows 上，HTTP 请求立即返回，前端轮询进度；
5. Cron Trigger 每天 UTC 05:00 自动运行。

> 这是科研信息筛选工具，不是生物医学结论的最终裁判。AI 解读只依据标题、摘要与元数据，关键结论必须回到原文和原始数据核验。

## 主要功能

- Europe PMC + PubMed 双源检索，摘要互补
- 查询逐级降级（严格 → 宽松），不会漏文章
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

正文采用 `ydchen-portfolio` 的暖米白、浅灰与赤陶色视觉系统，使用衬线标题和扁平化信息卡片；`YDchen Tools` 页眉结构与样式保持不变。

本项目为 Tools 工具类。页眉桌面 72px、手机（≤640px）64px；YDchen 为衬线 20px/600，Tools 为无衬线 20px/300，手机字标 18px；标题 18px/600、手机 16px；分隔线 36px/32px，品牌、分隔线与标题间距 16px/12px。

页眉内容区最大宽度 1280px（含两侧各 16px 内边距），整体居中；品牌和标题靠左，操作区靠右，窄屏换行后仍保持该对齐。品牌页眉在文档顶部正常排布，随页面滚走，不固定或吸顶；表格内部表头、侧边工具和手机底部导航可按功能保留。

正文采用统一系统无衬线字体，默认 16px / 1.6；标题采用 Georgia、Times New Roman、Songti SC、STSong 衬线族。数字与代码可使用 SFMono-Regular、Consolas、Liberation Mono、Microsoft YaHei 等宽族。按钮和输入通常 15px，辅助文字 12–14px，密集科学数据允许有理由的局部调整。页面底色 #f3eee5、正文 #24221f、赤陶强调 #a94f31，柔和底色上的强调文字 #823a25；科学分类色、热图、作品主题与状态色保留必要区分度。

## 数据与隐私

检索关键词、评分结果与每日简报保存在你自己的 Cloudflare D1 数据库中，不向第三方共享。管理令牌仅保存在当前浏览器会话（`sessionStorage`），关闭页面即失效。工具无账户系统，不收集个人信息；AI 评分只处理论文标题、摘要与元数据。

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
npx wrangler secret put ADMIN_TOKEN
```

4. 部署：

```bash
npm run deploy
```

部署时会自动创建 Cloudflare Workflows 绑定（`RADAR_WORKFLOW`），无需手动配置。日常迭代推送 `main` 分支即可经 Cloudflare Git 集成自动构建部署；本节手动步骤用于首次创建资源与排障。

可选：设置 NCBI API Key 以提高 PubMed 请求额度：

```bash
npx wrangler secret put NCBI_API_KEY
```

部署后在网址后加 `?demo=1` 可进入演示模式，使用假数据、不调用外部 API 或 AI。

## 责任边界

这是科研信息筛选工具，不是生物医学结论的最终裁判。AI 解读只依据标题、摘要与元数据，关键结论必须回到原文和原始数据核验。

## License

MIT

---

> AI 编程代理请阅读 [AGENTS.md](./AGENTS.md) 了解代码架构、测试策略与开发约定。

---

## 维护与兼容

文献同步与研究画像的阶段和百分比直接显示在主界面；中等屏幕及手机使用单列分析区，空态与失败提示使用中文。

配额倒计时移到页眉下方，长论文标题可换行，手机宽度不再被撑开；进度提示使用中文。补充请求超时/有限重试测试，覆盖 15 秒 AbortSignal、三次上限、400 不重试和 503 恢复。

检查命令与技术约束见 [AGENTS.md](./AGENTS.md)。上述浏览器验证描述对应 2026-09-13 的维护验收；后续修改仍须重新验证。

## AI 维护提醒

> **⚠️ 任何修改此项目的 AI 代理（Claude Code、Cursor、Copilot 等）都必须同步更新本文件与 AGENTS.md。**
>
> - 新增功能 → 在 README 中添加用户可理解的说明
> - 新增/删除文件 → 更新 AGENTS.md 中的文件清单
> - 修改架构 → 更新 AGENTS.md 的架构说明
> - 部署方式变更 → 同步更新本文部署章节
> - 保持 README 面向人类用户，AGENTS.md 面向 AI 代理，两份文件不可互相替代
