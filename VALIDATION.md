# 验证范围

开发入口见 [AGENTS.md](./AGENTS.md)，升级流程见 [UPGRADE.md](./UPGRADE.md)。

## 自动化检查

```bash
npm run check
npm test
```

- 语法检查按 package.json 覆盖 ai、query、radar、utils、search、storage、migrate、index 和 public/app.js。
- 单元测试覆盖查询约束、论文别名去重、检索层级扩大、历史结果、AI 失败降级、请求超时和暂时性错误重试。
- 测试使用固定输入与替代上游响应，不执行真实文献同步、生产 AI 或邮件任务。

## 浏览器与部署验证

核对 Tools 页眉、长标题换行、独立同步/画像进度，以及桌面、平板和手机布局。部署后确认 GitHub 提交、Cloudflare 构建状态及实际加载资源；使用禁用缓存或硬刷新检查页面。

涉及后端时补查真实上游、D1、Workflows 和相关绑定；语法与单元测试不能代替这些验证。Worker 打包或配置改动需执行 Wrangler dry run，生产数据库变更需先核对迁移与备份。
