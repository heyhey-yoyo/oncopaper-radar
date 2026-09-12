# OncoPaper Radar 部署与升级

本项目使用完整 Git 仓库与 Cloudflare Git 集成。日常修改推送 main 后自动部署；配置与模块说明见 [README.md](./README.md)、[AGENTS.md](./AGENTS.md)。

## 日常升级

先核对本地修改及 origin/main，审查差异并保留现有 D1 标识、域名、Workflows 绑定和部署环境变量。依赖按已提交的 lockfile 安装：

```bash
npm ci
npm run check
npm test
```

通过适用检查后提交经过审查的改动并推送 main，等待 Cloudflare 部署成功。确认部署 commit；浏览器禁用缓存/硬刷新，并核对加载的 HTML、CSS、JS，不能只看 GitHub 推送成功。

## 首次配置与数据库

首次部署需按 wrangler.jsonc 创建和绑定 D1、RADAR_WORKFLOW 与 AI，并在 Cloudflare 设置 ADMIN_TOKEN；未配置管理员令牌时拒绝管理操作。NCBI_API_KEY 为可选 secret。不要在源码、日志或文档写入真实 secret。

```bash
npx wrangler secret put ADMIN_TOKEN
```

现有 D1 由 src/migrate.js 的幂等迁移升级，不需要清空或重新初始化。schema.sql 用于新建数据库和本地开发；升级现有实例前备份并审查 schema 差异，禁止重新执行旧覆盖包中的重复 ALTER 脚本。文档修改无需数据库迁移。

Cloudflare 部署命令保持 npm run deploy 或 npx wrangler deploy，检查任务、数据库、AI 和 Cron 绑定。涉及 Worker 打包或配置修改时补做 npx wrangler deploy --dry-run。

## 运行核验

同步与画像为后台 Workflows 任务，HTTP 返回任务 ID，界面独立显示进度并可恢复轮询。Europe PMC/PubMed 请求有超时和有限重试；真实任务失败需核查任务状态、上游错误与管理员鉴权，不能以静态页面可打开代替成功。具体测试结果见 [VALIDATION.md](./VALIDATION.md)。
