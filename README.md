# Luffy · FC 26 screen-to-action adviser

本项目在本机把 OBS 的 Switch 画面交给视觉模型解析为结构状态，再由 TypeSafe AI / Jev 从有限的手柄动作里选择建议。它不向 Switch 自动发送按键。

## 获取 API key

1. 登录或注册 [TypeSafe Dashboard](https://console.typesafe.ai)。
2. 在 Dashboard 的 API key 页面创建 key。
3. 将 key 填入本地 `.env` 的 `TYPESAFE_API_KEY`。`.env` 已加入 `.gitignore`。

开发文档：[Introduction](https://docs.typesafe.ai/introduction)、[Quick Start](https://docs.typesafe.ai/introduction/quickstart)、[API Reference](https://docs.typesafe.ai/api)。官方 quick start 指定 `POST https://api.typesafe.ai/v1/systemone`，使用 Bearer 认证。请求包含 `state`、`model`、`questions`，题型有 `choice`、`score`、`noul`。

## 感知与闭环

TypeSafe Jev API 接收结构化文字状态，不接收原始图像。因此本项目保留独立视觉解析层：OpenAI-compatible 视觉模型读 OBS 截图，输出阶段、比分/时间、球、受控球员、可见球员位置、控球方、进攻方向、屏幕提示和置信度；低于 `MIN_VISION_CONFIDENCE` 就停止并回报“不建议按键”。Jev 再从调用方提供的合法动作候选中选一个，返回按键、模型置信度和候选概率。

调用方提供动作候选，是为了尊重 FC26 的平台/自定义按键布局及当前进攻/防守状态。不要让模型凭记忆猜 A/B/X/Y 的绑定。画面每次变化后再次调用，附上上一帧的感知状态，以便比较连续帧。当前接口只提供建议，不执行手柄动作；实际按下由玩家完成。

## OBS 配置

OBS 32 自带 obs-websocket。启用 WebSocket Server，并保持本机 loopback 访问；设置密码时将密码填入 `.env` 的 `OBS_WS_PASSWORD`。`.env` 已预设地址 `ws://127.0.0.1:4455` 和当前 OBS 源名 `采集卡设备`。可通过 `GET /api/obs/screenshot` 获取当前源截图。项目默认只监听 `127.0.0.1`。

## 视觉模型配置

在 `.env` 配置兼容 OpenAI Chat Completions 的视觉模型：

```dotenv
VISION_API_BASE_URL=https://api.openai.com/v1
VISION_API_KEY=你的视觉模型 API key
VISION_MODEL=gpt-4o-mini
MIN_VISION_CONFIDENCE=0.55
```

也可以换成支持图片输入和 JSON 输出的其他兼容服务。截图会发送给这个视觉服务解析；结构化 JSON 随后发送给 TypeSafe Jev 做动作选择。

## 运行

```bash
npm start
curl http://localhost:8787/healthz
```

## 单帧建议接口

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

`POST /api/fc26/obs-decide` 自动从 OBS 截图、视觉解析并调用 Jev。请求示例：

```json
{
  "candidates": [
    {"id":"wait","button":"无","description":"等待并继续观察"},
    {"id":"short_pass","button":"A","description":"短传给附近队友"},
    {"id":"shoot","button":"B","description":"射门"}
  ],
  "previousState": null
}
```

请求：

```bash
curl -sS http://127.0.0.1:8787/api/fc26/obs-decide \
  -H 'content-type: application/json' \
  -d @request.json
```

也可用 `POST /api/fc26/decide` 传入 `imageData` data URL、`candidates` 和可选 `previousState`，跳过 OBS 捕获。`GET /api/obs/screenshot` 用于检查当前画面源。底层 Jev 代理 `POST /api/jev/systemone` 保持 TypeSafe 原生格式。

当前只输出建议，不模拟已执行结果。玩家按下建议后再送下一帧；下一帧状态与 Jev 建议构成可重复的人机闭环。每个决策建议可由调用方保存为轨迹以便评估视觉识别、置信度和建议效果。
