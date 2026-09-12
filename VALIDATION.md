# 验证范围与结果

核对日期：2026-09-13。本文件替代早期覆盖包的“仅四文件检查、7 项测试、未包含 HTML/CSS”记录；当前为完整仓库。

## 本次实际执行

- npm run check 通过：按 package.json 检查 ai、query、radar、utils、search、storage、migrate、index 和 public/app.js 九个脚本。
- npm test：19 项通过，0 失败；包含查询约束、论文别名去重、检索层级扩大、历史结果、AI 失败降级、15 秒请求超时与暂时性错误重试。
- 以上测试使用测试输入和替代上游响应，没有运行真实文献同步、付费 AI 或邮件任务。

## 已有维护验收与边界

此前 2026-09-13 的浏览器维护已核验 Tools 页眉、长标题换行、独立同步/画像进度与桌面、平板、手机布局，并区分本地与线上资源。此次只整理文档，没有重新完成真实上游全链路、生产 D1 迁移、Workflows 任务或 Wrangler dry run。

后续功能改动按 [AGENTS.md](./AGENTS.md) 执行适用检查，部署按 [UPGRADE.md](./UPGRADE.md)。语法和单测通过不能替代真实任务、数据库及线上部署验证。
