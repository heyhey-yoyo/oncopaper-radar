# OncoPaper Radar 修复版部署说明

这个覆盖包只包含需要修改或新增的文件。`public/index.html` 与 `public/styles.css` 没有包含在包中，因此原页面结构、视觉样式和页眉会保持不变。

## 修复内容

- 同步和画像生成改为 Cloudflare Workflows 后台任务，HTTP 请求立即返回任务 ID。
- 前端通过短轮询显示任务阶段，刷新后可恢复正在运行的同步。
- 同时检索 Europe PMC 与真正的 PubMed ESearch，并在 Europe PMC 中补全摘要；命中数预检失败时会直接逐级试跑真实查询，双源故障不会误报为空结果。
- 查询按严格到宽松自动降级；画像限制为 1–2 个核心组、最多 2 个偏好组、每组最多 4 个词，并保留核心组/偏好组优先级。
- AI 改为短输出、两阶段评分、显式推理时限和最多两个模型；模型失败时使用确定性规则结果完成简报与画像。
- 所有候选写入去重表，未入选论文不会在相同画像和提示词版本下反复评分。
- 修复 Qwen 参数、日期查询、全局排名、模型记录和 JSON/index 校验。
- 删除公开 debug AI 入口；管理员认证改为未配置即拒绝。
- 新旧 D1 均可由运行时代码幂等升级，不依赖 GitHub 部署额外执行 SQL。

## 覆盖与检查

在你的现有仓库根目录解压本包，然后执行：

```bash
npm install
npm run check
npm test
```

首次部署前必须设置管理员令牌：

```bash
npx wrangler secret put ADMIN_TOKEN
```

可选：设置 NCBI API Key，以提高 PubMed E-utilities 的请求额度：

```bash
npx wrangler secret put NCBI_API_KEY
```

随后提交：

```bash
git add src/ai.js src/query.js src/index.js public/app.js wrangler.jsonc schema.sql package.json test/ai.test.js test/query.test.js UPGRADE.md CHANGED_FILES.md VALIDATION.md
git commit -m "fix: move literature radar to workflows and bounded AI"
git push
```

Cloudflare GitHub 自动部署会读取新的 `wrangler.jsonc`，创建 `RADAR_WORKFLOW` 绑定。应用第一次访问 API 时会自动创建新表并为旧 `digests` 表补充 `run_id`；现有简报和页面数据不会清空。

## 注意

- 不要再次运行旧版 `schema.sql`；旧文件含重复 `ALTER TABLE digests ADD COLUMN model`。
- 新版 `schema.sql` 主要用于全新 D1 或本地开发。现有远程 D1 无需手动初始化。
- 若 Cloudflare 构建设置覆盖了仓库脚本，部署命令应保持为 `npm run deploy` 或 `npx wrangler deploy`。
