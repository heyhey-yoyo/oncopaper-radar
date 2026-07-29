# OncoPaper Radar

一个可直接部署到 Cloudflare 的个人科研文献雷达 Demo，面向肿瘤分子机制研究。

它会：

1. 按你的关键词检索 Europe PMC 最近几天的新文章；
2. 用 D1 排除已经推送过的文章；
3. 让 Workers AI 按相关性、新颖性、证据强度、反直觉程度和实验启发评分；
4. 在网页中展示“为什么值得看、机制链、关键证据、主要疑点、最小判别实验”；
5. 由 Cron Trigger 每天自动运行。

> 这是科研信息筛选工具，不是生物医学结论的最终裁判。AI 解读只依据标题、摘要与元数据，关键结论必须回到原文和原始数据核验。

---

## 目录

```text
oncopaper-radar-demo/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ src/
│  └─ index.js
├─ package.json
├─ schema.sql
└─ wrangler.jsonc
```

## 0. 先看视觉 Demo

直接打开 `public/index.html`，或者在部署后的网址后加：

```text
?demo=1
```

例如：

```text
https://你的项目.workers.dev/?demo=1
```

演示模式使用假数据，不调用 Europe PMC、Workers AI 或 D1。

---

## 1. 准备环境

需要：

- 一个 Cloudflare 账户；
- Node.js 18 或更高版本；
- 能运行终端命令。

解压后进入项目目录：

```bash
cd oncopaper-radar-demo
npm install
npx wrangler login
```

登录命令会打开浏览器，让你授权 Wrangler 使用 Cloudflare 账户。

---

## 2. 创建 D1 数据库

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

打开 `wrangler.jsonc`，将：

```text
REPLACE_WITH_YOUR_D1_DATABASE_ID
```

替换成上一步返回的真实 `database_id`。

不要改绑定名 `DB`，后端代码通过 `env.DB` 访问数据库。

---

## 3. 初始化远程数据库

```bash
npm run db:init:remote
```

看到 SQL 执行成功后，可以检查默认配置：

```bash
npm run db:show:remote
```

---

## 4. 建议设置管理员令牌

不设置令牌时，任何拿到网站地址的人都可以保存配置或触发 AI 同步。个人测试可以先不设置；公开部署强烈建议设置：

```bash
npx wrangler secret put ADMIN_TOKEN
```

输入一串你自己生成的长随机字符串。部署后点击网页右上角“管理员令牌”，填入同一个字符串。

令牌只保护：

- 保存配置；
- 手动触发同步。

读取简报仍然是公开的。如果连简报也需要保密，建议再给 Worker 配置 Cloudflare Access。

---

## 5. 部署

```bash
npm run deploy
```

命令完成后会显示类似：

```text
https://oncopaper-radar.你的子域.workers.dev
```

打开该地址。

第一次使用：

1. 输入管理员令牌（设置过才需要）；
2. 检查关键词；
3. 点击“保存配置”；
4. 点击“立即同步”；
5. 等待页面显示入选文章。

---

## 6. 关键词怎么写

“检索概念”采用：

- 每行是一个必须满足的概念；
- 同一行用 `|` 写同义词，表示满足其中任意一个。

例如：

```text
KRAS G12D | KRASG12D
pancreatic cancer | pancreatic ductal adenocarcinoma | PDAC
ferroptosis | lipid peroxidation
```

它会构造成大致如下的逻辑：

```text
(KRAS G12D OR KRASG12D)
AND
(pancreatic cancer OR pancreatic ductal adenocarcinoma OR PDAC)
AND
(ferroptosis OR lipid peroxidation)
```

开始时不要放太多行。建议先用 2–3 个核心概念，否则每天可能完全没有结果。

### 示例：肿瘤免疫逃逸

```text
tumor immune escape | immune evasion
pancreatic cancer | PDAC
myeloid | macrophage | neutrophil
```

### 示例：耐药机制

```text
osimertinib resistance
EGFR mutant | EGFR-mutant
lung cancer | NSCLC
```

### 示例：表观遗传与代谢

```text
METTL3 | m6A
ferroptosis
cancer
```

---

## 7. “有趣”偏好怎么写

这是给 AI 的研究者画像，不是检索式。例如：

```text
优先原创机制研究；关注遗传学证据、rescue、催化失活突变体、
时间序列、体内模型和患者样本；喜欢与既有认识矛盾或可直接启发实验的结果；
降低纯生信预后模型、只有相关性表达分析和没有功能验证文章的评分。
```

不要在这里放未公开患者信息、身份信息或敏感临床数据。

---

## 8. 自动运行时间

`wrangler.jsonc` 当前配置：

```json
"triggers": {
  "crons": ["0 5 * * *"]
}
```

Cron Trigger 使用 UTC。这代表每天 **05:00 UTC** 执行：

- 芬兰夏令时约 08:00；
- 芬兰冬令时约 07:00。

需要修改时，编辑 cron 表达式后重新部署：

```bash
npm run deploy
```

夏令时切换不会自动改变 UTC cron。如果必须全年固定本地时间，需要按季节调整 cron，或改为更复杂的定时逻辑。

---

## 9. 本地开发

先初始化本地 D1：

```bash
npm run db:init:local
```

再启动：

```bash
npm run dev
```

通常地址是：

```text
http://localhost:8787
```

配置中 Workers AI 使用 `remote: true`，所以本地开发时模型仍在 Cloudflare 远程运行，也会计入 Workers AI 用量。

测试 scheduled handler：

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
```

也可以直接在网页点击“立即同步”。

---

## 10. 常见问题

### 页面提示 D1 尚未初始化

确认：

1. `wrangler.jsonc` 已替换正确的 `database_id`；
2. 已运行 `npm run db:init:remote`；
3. 初始化和部署使用的是同一个 Cloudflare 账户。

### 管理员令牌不正确

重新运行：

```bash
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

然后清除网页中的旧令牌，再输入新令牌。

### 一篇文章都没有

先尝试：

- 减少“检索概念”的行数；
- 把回看窗口改成 7 或 14 天；
- 删除过于具体的一个概念；
- 检查基因和药物的常用别名；
- 先在 Europe PMC 网站上验证检索词。

### AI 同步报错

可能原因：

- Workers AI 当日免费额度已用完；
- 模型临时不可用；
- AI 无法满足 JSON Schema；
- 候选摘要太少或 Europe PMC 暂时异常。

打开 Cloudflare 控制台中的 Worker 日志查看具体错误。

### 为什么用重叠日期窗口

文献数据库的索引日期和正式发表日期不一定同步。每天回看 4–7 天，再通过 D1 去重，比只检索过去 24 小时更不容易漏文章。

---

## 11. 当前 Demo 的边界

已实现：

- Europe PMC 检索；
- 多概念 / 同义词检索；
- 日期窗口；
- 原创研究排除项；
- Workers AI 结构化评分；
- D1 去重与简报存储；
- Cron 每日同步；
- 可选管理员令牌；
- 响应式网页。

暂未实现：

- 邮件、Telegram、企业微信推送；
- 点赞 / 不感兴趣反馈学习；
- PDF 全文解析；
- 多用户账号；
- Vectorize 语义记忆；
- PubMed 与 bioRxiv 的独立补充源。

最适合的下一步是接入邮件推送，或加入“👍 有用 / 👎 不相关”反馈表，使筛选偏好逐步个性化。

---

## 官方参考

- Cloudflare Workers Static Assets  
  https://developers.cloudflare.com/workers/static-assets/
- Workers AI bindings  
  https://developers.cloudflare.com/workers-ai/configuration/bindings/
- Workers AI JSON Mode  
  https://developers.cloudflare.com/workers-ai/features/json-mode/
- D1 getting started  
  https://developers.cloudflare.com/d1/get-started/
- Cron Triggers  
  https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Europe PMC REST API  
  https://europepmc.org/RestfulWebService
