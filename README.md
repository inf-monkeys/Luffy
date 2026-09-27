# Luffy · Jev API gateway

这是一个从零搭建的本地 Jev API 服务。它把 Jev API key 留在服务端环境变量中，给本地应用提供一个受控代理，不把 key 暴露给浏览器。

## 1. 获取 Jev API key

1. 打开 [Jev Keys](https://www.jevai.org/agent/keys)，先在页面顶部登录 Jev AI Community。
2. 在 API Keys 页面创建或替换 personal key。
3. 复制**只在创建/替换时显示一次**的完整 key。不要把它提交 Git、放入前端代码、截图或聊天记录。
4. 在本项目根目录创建 `.env`，填入：

```dotenv
PORT=8787
JEV_BASE_URL=https://www.jevai.org
JEV_API_KEY=在这里粘贴你的 key
```

Jev 的 REST 文档在 [Jev API Docs](https://www.jevai.org/docs)。官方要求使用 `Authorization: Bearer <key>`，请求发往 `https://www.jevai.org/api/v1/...`。请求体上限为 32 KiB。

## 2. 本地运行

```bash
npm run check
npm start
```

健康检查：

```bash
curl http://localhost:8787/healthz
```

## 3. 调用 Jev

原生决策：

```bash
curl -sS http://localhost:8787/api/jev/decisions \
  -H 'content-type: application/json' \
  -d '{
    "state": {"customer_identity_verified": true, "amount_usd": 680},
    "questions": {
      "action": {
        "type": "choice",
        "instructions": "Choose the safest next action.",
        "criteria": {"allow": "Issue immediately", "review": "Require human approval", "deny": "Reject"}
      }
    }
  }'
```

已映射的工作流：

- `POST /api/jev/decisions`
- `POST /api/jev/decisions/tool-guard`
- `POST /api/jev/decisions/model-route`
- `POST /api/jev/decisions/route`
- `POST /api/jev/decisions/research`
- `POST /api/jev/decisions/completion`

服务只转发 JSON 和 Jev 返回值；它不会执行 Jev 返回的工具动作。涉及不可逆操作时，调用方必须自行做人审/确认。
