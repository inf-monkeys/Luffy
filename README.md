# Luffy · TypeSafe AI / Jev gateway

本项目为本地应用提供 TypeSafe AI System One API 代理。API key 只存放在服务端 `.env` 中，不进入浏览器代码。

## 获取 API key

1. 登录或注册 [TypeSafe Dashboard](https://console.typesafe.ai)。
2. 在 Dashboard 的 API key 页面创建 key。
3. 将 key 填入本地 `.env` 的 `TYPESAFE_API_KEY`。`.env` 已加入 `.gitignore`。

开发文档：[Introduction](https://docs.typesafe.ai/introduction)、[Quick Start](https://docs.typesafe.ai/introduction/quickstart)、[API Reference](https://docs.typesafe.ai/api)。官方 quick start 指定 `POST https://api.typesafe.ai/v1/systemone`，使用 Bearer 认证。请求包含 `state`、`model`、`questions`，题型有 `choice`、`score`、`noul`。

## 运行

```bash
npm start
curl http://localhost:8787/healthz
```

## 调用

```bash
curl -sS http://localhost:8787/api/jev/systemone \
  -H 'content-type: application/json' \
  -d '{
    "state": "A customer reports a failed payment integration.",
    "model": "jev-latest",
    "questions": {
      "urgency": {
        "type": "noul",
        "instructions": "Does this message express urgency?"
      }
    }
  }'
```

代理端点 `POST /api/jev/systemone` 使用与 TypeSafe API 相同的请求/响应格式。代理不会执行 Jev 返回的动作；业务方应根据结构化结果自行决定后续处理。
