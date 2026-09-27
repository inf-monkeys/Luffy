# Luffy · FC26 screen-to-action adviser

本地工具把 Switch 采集卡画面从 OBS 读出，用本机 OpenCV 提取保守的画面线索，再把结构状态与合法动作候选交给 TypeSafe AI / Jev 选择。它只显示建议，不向 Switch 发送按键。

## Jev API

在 [TypeSafe Dashboard](https://console.typesafe.ai) 创建 personal API key，填入本地 `.env` 的 `TYPESAFE_API_KEY`。开发文档：[Introduction](https://docs.typesafe.ai/introduction)、[Quick Start](https://docs.typesafe.ai/introduction/quickstart)、[API Reference](https://docs.typesafe.ai/api)。请求发往 `POST https://api.typesafe.ai/v1/systemone`，使用 Bearer 认证。`.env` 在 `.gitignore` 中，不要提交或分享。

## 视觉处理与边界

- OBS 截图通过本机认证的 obs-websocket 获取，不上传给视觉服务。
- OpenCV 在本机定位可能的草地球场区域，并可从前后帧计算变化区域。这些不是球员/足球检测结果。
- 经典图像处理目前无法可靠识别 FC26 的受控球员、队伍、持球权、比分和比赛时钟；这些字段保持 unknown/null，置信度低于默认 `MIN_VISION_CONFIDENCE=0.55` 时不调用 Jev。
- ASCII 只能做已识别结构的文字摘要；整帧转字符不能稳定识别 FC26 的球、球员或控球关系。当前流程不把 ASCII 当感知器。
- Jev 输入只包含结构化状态和你提供的动作候选。动作名称应按游戏内控制设置填写；建议必须由玩家手动决定是否执行。

后续如接入球员/足球检测器、HUD OCR 或受控球员标识，须先用真实 FC26 Switch 画面标注与验证检测精度，再调整置信度门槛。未验证前系统选择 abstain，避免虚构动作建议。

## OBS 配置

OBS 32 自带 obs-websocket。打开“工具 → WebSocket 服务器设置”，启用服务器、保持身份认证开启，端口用 `4455`，只在本机使用。`.env` 设 `OBS_WS_URL=ws://127.0.0.1:4455`、`OBS_SOURCE_NAME=采集卡设备`，并在 `OBS_WS_PASSWORD` 填入 OBS 当前服务器密码。密码不要提交到 Git。

## 安装运行

```bash
cp .env.example .env
# 编辑 .env：填写 TYPESAFE_API_KEY 与 OBS_WS_PASSWORD
npm run setup:vision
npm run check
npm start
```

打开 <http://127.0.0.1:8787>。服务默认只监听 `127.0.0.1`。健康检查：`GET /healthz`。截图接口：`GET /api/obs/screenshot`。停止低置信状态继续到建议：`POST /api/fc26/obs-decide`。手动传图分析：`POST /api/fc26/decide`。底层 Jev 代理：`POST /api/jev/systemone`。

`obs-decide` 请求示例：

```json
{
  "candidates": [
    {"id":"wait","button":"WAIT","description":"等待并继续观察"},
    {"id":"short_pass","button":"A","description":"短传给附近队友（按当前自定义布局核对）"}
  ],
  "previousState": null
}
```

本地控制台提供 OBS 抓帧、状态/置信度展示和建议。用户手动执行或跳过后再点“下一帧建议”，形成有人确认的闭环。当前 OpenCV 感知能力有限，因此预期在实际比赛帧上 abstain；画面结构识别尚未完成验证。
