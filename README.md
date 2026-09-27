# Luffy · 通用游戏实时建议器

本地工具从 OBS 读取采集卡画面，用 OpenCV 在本机生成通用视觉摘要，再由 TypeSafe AI / Jev 从用户定义的合法操作里选择建议。适用于 Switch 等平台上的不同游戏。它只显示建议，不向主机发送按键。

## Jev API

在 [TypeSafe Dashboard](https://console.typesafe.ai) 创建 personal API key，填入本地 `.env` 的 `TYPESAFE_API_KEY`。开发文档：[Introduction](https://docs.typesafe.ai/introduction)、[Quick Start](https://docs.typesafe.ai/introduction/quickstart)、[API Reference](https://docs.typesafe.ai/api)。请求发往 `POST https://api.typesafe.ai/v1/systemone`，使用 Bearer 认证。`.env` 在 `.gitignore` 中，不要提交或分享。

## 通用画面摘要

- OBS 截图通过本机认证的 obs-websocket 获取，不上传给视觉服务。
- OpenCV 生成 64×36 的颜色量化 ASCII 地图、变化比例和帧间运动区域。地图 glyph 表示近似颜色；系统不把它们冒充角色、道具或游戏机制检测。
- 用户在控制台指定游戏/平台、当前目标、可选状态说明和合法按键候选。Jev 只从候选里选；上下文不足时要求选择 WAIT。
- 像素 ASCII 是有损摘要，可能看不清小物体或 HUD。建议由玩家判断是否执行。切换游戏时要更新目标和按键映射。

## 实时运行

打开控制台后点一次“开始实时”，页面会持续向 OBS 抓帧并刷新摘要；当前实现每轮结束后约 100 ms 开始下一轮，本机测得约 3 帧/秒，实际速度取决于采集分辨率和机器负载。再点“暂停实时”停止。Jev 只在摘要成功后调用，间隔至少 2.5 秒，避免每帧重复请求。一次已观测调用耗时约 0.7 秒；真实延迟随网络和服务负载变化。

```bash
cp .env.example .env
# 编辑 .env，填写 TYPESAFE_API_KEY 和 OBS_WS_PASSWORD
npm run setup:vision
npm run check
npm start
```

打开 <http://127.0.0.1:8787>。OBS 设置位于“工具 → WebSocket 服务器设置”；保持认证开启，地址 `ws://127.0.0.1:4455`，源名 `采集卡设备`。服务默认只监听 `127.0.0.1`。

## HTTP 接口

- `GET /healthz`：服务状态。
- `GET /api/obs/screenshot`：读取当前 OBS 源截图。
- `POST /api/game/obs-decide`：抓取最新帧、生成 OpenCV 摘要并调用 Jev。
- `POST /api/game/decide`：用传入的截图生成摘要并调用 Jev。
- `POST /api/jev/systemone`：TypeSafe System One 代理。

`obs-decide` 请求示例：

```json
{
  "game": "Nintendo Switch 游戏",
  "objective": "解开机关并避开敌人",
  "stateNotes": "角色刚进入关卡，生命值充足",
  "candidates": [
    {"id":"wait","button":"WAIT","description":"等待并观察"},
    {"id":"a","button":"A","description":"确认/交互"},
    {"id":"b","button":"B","description":"当前游戏中的次要动作"}
  ]
}
```

老版本 `/api/fc26/*` 路由暂时保留兼容。
