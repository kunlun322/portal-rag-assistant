# portal-rag-assistant

**portal-rag-assistant = portal（官网门户）+ RAG（检索增强生成知识库问答）+ assistant（助手）** —— 蔚小理汽车 NEXLI 官网的智能客服助手。

站点前端是「蔚小理汽车 NEXLI」品牌官网（4 个页面，品牌与内容保持不变），页面右下角的在线客服弹窗由 **portal-rag-assistant** 驱动：它通过服务端代理接入 [Qoder Cloud Agents](https://docs.qoder.com/zh/cloud-agents/overview) 上已配置好的新能源汽车知识库问答 Agent，实现流式（SSE）智能问答。

## 为什么必须启动后端服务？

**直接双击打开 `index.html`，客服功能不可用。** 原因是：

- 调用 Qoder Cloud Agents API 必须携带密钥（PAT），出于安全要求密钥只能保存在服务端，绝不能出现在前端代码或浏览器里；
- 因此所有 API 请求都由本项目的服务端代理转发（`/api/chat/*`），纯静态双击打开没有服务端，客服弹窗发消息会失败。

正确用法：**先启动本地服务，再通过浏览器访问 `http://localhost:8787`。**

## 目录结构

```
portal-rag-assistant/
├── index.html            # 首页
├── about.html            # 关于我们
├── model.html            # 车型页
├── technology.html       # 科技页
├── styles.css            # 全站样式
├── customer-service.css  # 客服弹窗样式
├── customer-service.js   # 客服弹窗前端逻辑（不含任何密钥）
├── images/               # 站点图片
├── vendor/marked.min.js  # Markdown 渲染库（离线内置）
├── server.js             # 本地服务端入口（静态托管 + API 代理，零依赖）
├── lib/qoder.js          # Qoder API 代理核心逻辑（本地与 Vercel 共用）
├── api/chat/             # Vercel Serverless 函数
│   ├── session.js        #   POST /api/chat/session  创建会话
│   ├── message.js        #   POST /api/chat/message  发送消息
│   └── stream.js         #   GET  /api/chat/stream   SSE 事件流
├── vercel.json           # Vercel 零配置部署声明
├── package.json          # 含 engines（Node 版本）与 start 脚本
├── .env.example          # 凭证配置模板（复制为 .env 使用）
├── .gitignore            # 忽略 node_modules/、.env 等
└── README.md
```

## 快速开始（本地运行）

环境要求：Node.js ≥ 18（见 `package.json` 的 `engines`）。**本项目零第三方依赖，无需 `npm install`。**

1. 配置凭证：复制 `.env.example` 为 `.env`，填入真实值：

   ```bash
   cp .env.example .env
   # 编辑 .env，填入 QODER_PAT / QODER_IDENTITY_ID / QODER_TEMPLATE_ID
   ```

2. 启动服务：

   ```bash
   npm start        # 等价于 node server.js
   ```

3. 浏览器访问 <http://localhost:8787>，点击右下角「在线客服」即可开始问答。

   如需更换端口，在 `.env` 中设置 `PORT=3000`（或启动时 `PORT=3000 npm start`）。

## 凭证配置说明

| 环境变量 | 说明 | 在哪里获取 |
| --- | --- | --- |
| `QODER_PAT` | Qoder Cloud Agents 个人访问令牌（PAT） | Qoder 平台个人设置 |
| `QODER_IDENTITY_ID` | Identity ID（`idn_` 开头） | Qoder Cloud Agents |
| `QODER_TEMPLATE_ID` | 客服问答 Agent 的 Template ID（`tmpl_` 开头） | Qoder Cloud Agents |
| `PORT` | 本地端口，可选，默认 `8787` | — |

- **本地运行**：写入项目根目录 `.env`（已被 `.gitignore` 忽略），或直接用 shell 环境变量。
- **Vercel 部署**：在 Vercel Dashboard → 项目 → Settings → Environment Variables 中配置同名变量（见下文）。
- 代码仓库中**只保留 `.env.example` 占位符模板，不含任何真实凭证**；请勿把真实值提交到仓库、写进前端代码或粘贴到任何公开位置。

## Vercel 部署（GitHub → Vercel 自动部署）

项目已按 Vercel **零配置自动识别**结构设计：根目录 `vercel.json` + `api/` Serverless 函数 + 根目录静态页面，**无构建步骤（零 build 命令）**。

1. 把本仓库推送到 GitHub；
2. 在 [Vercel](https://vercel.com) 中 New Project → Import 该仓库；
3. Vercel 自动识别并保持默认（Framework 无需选择、Build Command 留空、Output 为根目录），直接 Deploy；
4. **唯一的人工步骤**：在项目 Settings → Environment Variables 中配置 `QODER_PAT`、`QODER_IDENTITY_ID`、`QODER_TEMPLATE_ID`（Production / Preview / Development 三个环境都勾选），然后重新部署一次使变量生效。

> 这一步是凭证安全要求：密钥不入库，只能在部署平台上配置，无法也不应省略。此后 push 到 GitHub 即自动部署，再无其他人工环节。

接口实现说明：`/api/chat/session`、`/api/chat/message`、`/api/chat/stream` 三个端点在 Vercel 上由 `api/chat/*.js` 无服务器函数承载，与本地 `server.js` 复用同一份代理逻辑（`lib/qoder.js`）。SSE 流式响应在 Vercel Node.js Runtime 上通过流式透传实现，并已为 stream 函数声明 `maxDuration: 60`；若单轮回答超过平台函数时长上限，前端会按 SSE 断线重连机制（`Last-Event-ID` 续传）自动恢复。

## FAQ

**Q：双击 `index.html` 打开后，客服发不出消息？**
A：这是预期行为。客服必须经服务端代理调用 API，请先 `npm start` 再访问 `http://localhost:8787`。

**Q：启动后提示 `missing_server_config` / 消息发送失败？**
A：服务端没读到凭证。确认 `.env` 在项目根目录、三个变量名拼写正确且无多余空格；或改用环境变量方式注入。

**Q：PAT 可以写在前端吗？**
A：不可以。PAT 一旦进入浏览器即可被任何人从 Network 面板读取。本项目所有 Qoder 请求均由服务端携带密钥转发，前端与浏览器中不出现任何凭证。

**Q：为什么页面品牌仍是「蔚小理 NEXLI」？**
A：`portal-rag-assistant` 是工程项目名（仓库、`package.json`、部署配置等工程标识）；站点页面内的品牌与内容属于业务设计，保持不变。

**Q：Vercel 上 SSE 不稳定怎么办？**
A：优先确认三个环境变量已配置并重新部署；Hobby 计划函数默认时长较短，stream 函数已声明 `maxDuration: 60`。前端自带断线重连（`Last-Event-ID` 续传），短暂中断可自动恢复。

**Q：端口被占用？**
A：`PORT=3000 npm start` 换一个端口即可。
