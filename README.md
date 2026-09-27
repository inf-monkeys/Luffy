# Luffy · 通用游戏实时建议器

本地控制台把采集卡作为浏览器实时视频源展示，由本机 OmniJev 在后台按节奏读取采样帧并从用户定义的合法操作里选择建议。适用于 Switch 等平台上的不同游戏。控制器输出层默认是 dry-run，不会向主机发送按键。

## Jev API

默认 provider 是本机 Jev-Omni：Luffy 把后台采样得到的推理帧发送到 `http://127.0.0.1:8788/v1/judge`，同时把游戏介绍、按键语义、目标、状态和合法动作作为 typed-choice 问题传入。模型直接从画面完成视觉判断。

如果需要临时切回 TypeSafe 云端接口，把 `.env` 中的 `JEV_PROVIDER` 改为 `typesafe`，并填写 `TYPESAFE_API_KEY`。

在 [TypeSafe Dashboard](https://console.typesafe.ai) 创建 personal API key，填入本地 `.env` 的 `TYPESAFE_API_KEY`。开发文档：[Introduction](https://docs.typesafe.ai/introduction)、[Quick Start](https://docs.typesafe.ai/introduction/quickstart)、[API Reference](https://docs.typesafe.ai/api)。请求发往 `POST https://api.typesafe.ai/v1/systemone`，使用 Bearer 认证。`.env` 在 `.gitignore` 中，不要提交或分享。

## 视频预览与原始视觉决策

- 网页预览使用浏览器 `MediaStream` 直接播放采集卡或 OBS Virtual Camera，避免用几秒一次的 JPEG 截图刷新画面。
- 浏览器实时视频只负责观看；后台决策仍通过本机认证的 obs-websocket 取样本帧，不上传给视觉服务。
- 后台先以高清模式读取采集卡，再只把缩小后的推理帧交给 OmniJev-4B 5-bit；网页的高清 MediaStream 不会复用这张缩小图。
- 用户在控制台指定游戏/平台、当前目标、可选状态说明和合法按键候选。OmniJev 只从候选里选；上下文不足时要求选择 WAIT。
- 切换游戏时要更新目标、游戏介绍和按键映射；模型负责从采样画面读取场景信息。
- 完整 profile 会保留在配置和网页中；每帧本地决策请求只发送目标、状态规则和候选动作的紧凑映射，候选标签只保留动作 ID 和短语，避免重复把全部按键文档塞进 OmniJev 的 prompt，造成不必要的延迟。

## 实时运行

打开控制台后，页面会请求视频设备权限并建立实时视频流；可在画面下方选择采集卡或 OBS Virtual Camera。点击“开始自动执行”后，后台按决策间隔取样并把缩小后的推理帧交给 OmniJev；再点“停止”结束。当前 4B 5-bit 模型在 87,808 像素输入上的暖机中位约 737 ms，实际速度取决于采集分辨率和机器负载。自动运行日志会同时记录总耗时、模型耗时和 Jev HTTP 往返耗时，便于区分模型慢还是服务链路慢。

```bash
cp .env.example .env
# 默认使用本机 Jev-Omni；只有切换为 typesafe provider 时才需要 TYPESAFE_API_KEY
# 另外填写 OBS_WS_PASSWORD 和 OBS_SOURCE_NAME
npm run check
npm start
```

打开 <http://127.0.0.1:8787> 并允许浏览器访问摄像头/视频设备。如果采集卡已被 OBS 独占，请在 OBS 中启动“虚拟摄像机”，然后在控制台画面下方选择 `OBS Virtual Camera`。OBS 的截图接口仍用于后台决策采样；其设置位于“工具 → WebSocket 服务器设置”，保持认证开启，地址 `ws://127.0.0.1:4455`，源名必须与 OBS 场景中的来源名称一致（当前示例为 `视频采集设备`）。服务默认只监听 `127.0.0.1`。

网页控制台把采集卡画面铺满首屏，左侧是悬浮工具栏，右侧白色控制面板分为“设置 / 手动操作 / 行为日志”三个视图；所有 Jev、网页手柄和网关收到的动作统一显示在操作记录中。视觉管线固定为 OmniJev 原始视觉。开启“自动执行”后，动作会通过现有 Pico UDP 控制器发送；关闭时仍会做推理但每次 dispatch 都由网关强制 dry-run。即使运行尚未启动，经过 Luffy 的手柄 dispatch 也会写入同一份操作记录。

首屏把采集卡画面和 **Switch 2 手柄**放在同一视图：宽屏左右并排，窄屏手柄悬浮在画面右下方。手柄是可操作的 Joy-Con 2 外观控制器：点击/触控按住按键、拖动左右摇杆，或使用 `WASD`、方向键、`ABXY`、`Q/E` 键盘输入，都会调用同一个 `POST /api/controller/dispatch` 接口。网关在 `CONTROLLER_MODE=udp` 时把完整手柄状态发送到树莓派 Pico 2 W（默认 `192.168.4.1:8765`），Pico 再通过 USB HID 模拟 Switch Pro 手柄；释放按钮会发送中性状态，避免按键粘住。面板右上角会显示当前 UDP/dry-run 状态。

### 启动本地 OmniJev-4B

Luffy 的本地 provider 需要单独启动 MLX 推理进程。当前默认使用本地 OmniJev-4B 5-bit 权重和官方决策头；在另一个终端执行：

```bash
cd "/Users/leo/WorkSpace/Luffy/Luffy-Source-Code"
"/Users/leo/WorkSpace/Luffy/jev-omni-venv/bin/uvicorn" \
  jev_omni_server:app --app-dir src --host 127.0.0.1 --port 8788
```

先确认 `http://127.0.0.1:8788/health` 返回 `ready: true` 且 `model` 指向 `Qwen3.5-4B-OmniJev-MLX-5bit`，再启动 Luffy 网关。默认 `JEV_OMNI_MAX_PIXELS=87808`，对应已配对验证过的 112 级输入；提高到 `175616` 会保留更多细节，但会把暖机后中位延迟从约 737 ms 增加到约 1,050 ms。模型目录、决策头和输入像素可以分别通过 `JEV_OMNI_MODEL_PATH`、`JEV_OMNI_HEAD_PATH`、`JEV_OMNI_MAX_PIXELS` 覆盖。Luffy 默认给本地 Jev 请求 30 秒保护时间，避免首轮模型热身或偶发慢推理把后续请求排队。

本地 OmniJev 直接读取图片，Luffy 不再启动额外图像处理子进程，也不再安装额外视觉依赖。

### 连续运行与游戏配置

`live:drive` 是通用运行时：它持续从采集卡取帧，调用 `/api/game/decide`，再把高于置信度门槛的建议发给 Pico。它不会把游戏规则写死在核心代码里。游戏名称、游戏介绍、控制器协议、玩法状态、每个按键的含义/按法/使用时机、采集参数和合法动作都来自 `profiles/` 下任意层级的 `*.json`（`*.schema.json` 除外），也可以用环境变量覆盖。

默认配置是 `switch-generic`，只提供安全的通用 Switch 动作，适合检查链路或菜单操作；它不等于“自动会玩所有游戏”。想让模型实际玩某个游戏，需要给出该游戏的介绍、目标、控制语义和候选动作。当前赛车实验配置在 `profiles/mario-kart-world.json`；所有配置都使用 OmniJev 原始视觉。

### 游戏配置固定 schema

配置必须声明 `schema_version: 1`，并符合 [`profiles/game-profile.schema.json`](profiles/game-profile.schema.json)。运行时加载配置时会执行同一套校验，缺少字段或没有描述标准控制项的配置不会启动。核心字段如下：

- `introduction`、`objective`、`state_notes`：告诉模型游戏是什么、当前要完成什么以及决策边界。
- `controller`：声明 Switch Pro Controller 的按键编码、是否支持同时按键/摇杆，以及当前 Pico 没有的陀螺仪、加速度计和震动能力。
- `gameplay`：声明 active/non-active 状态和完成信号，例如结果画面。
- `controls`：必须完整描述 `A/B/X/Y/L/R/ZL/ZR`、十字键、`L3/R3`、`PLUS/MINUS`、`HOME/CAPTURE`、左右摇杆和 `WAIT`；每一项都要有 `type`、`meaning`、`how_to_press`、`when_to_use`。
- `observations`：描述模型应该从画面读取的游戏元素，例如道路、地图、圈数和状态。
- `candidates`：模型实际可以选择的有限动作；`buttons` 表示可同时按下的键，摇杆使用 `-1..1` 坐标，`duration_ms` 表示建议保持时间。

新增游戏时复制一个 profile，补齐以上字段和候选动作即可。标准控制器能力由 `src/profile_schema.mjs` 与 JSON Schema 双重约束，避免不同游戏配置向模型传入不一致的按键词汇。

它是一个安全实验驱动：发生异常、低置信度或收到 `Ctrl-C` 时发送 `WAIT`，不会继续保持上一个动作。

```bash
cd "/Users/leo/WorkSpace/Luffy/Luffy-Source-Code"
LUFFY_PROFILE=mario-kart-world \
MAX_STEPS=0 \
DECISION_INTERVAL_MS=1200 \
ACTION_DURATION_MS=1000 \
MIN_ACTION_CONFIDENCE=0.65 \
npm run live:drive
```

可以通过 `LUFFY_PROFILE_PATH` 指定自定义配置文件，或通过 `CAPTURE_DEVICE`、`CAPTURE_SOURCE_SIZE`、`CAPTURE_SOURCE_FRAMERATE`、`INFERENCE_SIZE`、`INFERENCE_FRAMERATE`、`CAPTURE_SIZE`、`CAPTURE_FRAMERATE`、`LUFFY_GAME`、`LUFFY_OBJECTIVE`、`LUFFY_STATE_NOTES` 和 `LUFFY_CANDIDATES_JSON` 覆盖配置。`CAPTURE_SIZE`/`CAPTURE_FRAMERATE` 仍兼容旧配置，但现在只控制发送给推理服务的帧；`CAPTURE_SOURCE_SIZE`/`CAPTURE_SOURCE_FRAMERATE` 控制共享采集卡的高清输入，默认是 `1920x1080@30`。如果采集卡不支持该模式，可改成它支持的高清模式。先用 `MAX_STEPS=3` 做小规模验证，再让它持续运行；按 `Ctrl-C` 会先把 Pico 回中。

## 控制器输出抽象

当前 `CONTROLLER_MODE=manual`，Jev 建议不会自动发送给任何设备。Luffy 已预留显式的 `POST /api/controller/dispatch` 边界。设置 `CONTROLLER_MODE=http` 后，它会把动作发送到配置的 HTTP 端点；设置为 `udp` 后，它会向 Pico 2 W 的 UDP 地址（默认 `192.168.4.1:8765`）发送动作 JSON。默认仍不会因为收到 Jev 建议而自动执行。

Pico 2 W 固件和刷写说明见 [`firmware/pico2w-agent`](firmware/pico2w-agent)。该版本让 Pico 自己模拟 Switch Pro 手柄，并通过 `Jev-Pico` Wi‑Fi 热点接收动作，不需要蓝牙手柄或 USB-UART 转接器。

适配器接收的通用动作格式为：`button` 保留用于单键兼容；`buttons` 可同时按下多个数字键；两个摇杆使用 `-1..1` 的归一化坐标，`y=1` 表示向上：

```json
{
  "action": {
    "id": "a",
    "button": "A",
    "buttons": ["A", "ZR"],
    "left_stick": {"x": 0.0, "y": 0.0},
    "right_stick": {"x": 0.0, "y": 0.0},
    "description": "确认/交互",
    "duration_ms": 120,
    "params": {}
  },
  "source": "operator"
}
```

支持的数字键包括 `A/B/X/Y`、`L/R/ZL/ZR`、`UP/DOWN/LEFT/RIGHT`、`L3/R3`、`PLUS/MINUS`、`HOME/CAPTURE` 和 `WAIT`。Pico 固件会在 `duration_ms` 内保持整帧状态，结束后自动回到中性状态。当前固件没有陀螺仪、加速度计和震动回传，因此这三类输入输出保持中性或被忽略。

## HTTP 接口

- `GET /healthz`：服务状态和当前 Jev provider。
- `GET /api/profiles`：递归读取 `profiles/` 下任意层级的 `*.json` 游戏配置档（排除 `*.schema.json`）。
- `GET /api/runtime/status`：连续运行状态、控制器状态和最近操作记录。
- `GET /api/runtime/events`：SSE 实时事件流。
- `POST /api/runtime/start` / `POST /api/runtime/stop`：从网页启动或停止连续 Agent。
- `GET /api/obs/screenshot`：读取当前 OBS 源截图。
- `POST /api/game/obs-decide`：抓取最新帧并把截图交给当前 Jev provider。
- `POST /api/game/decide`：用传入的截图调用当前 Jev provider。
- `POST /api/controller/dispatch`：显式发送或 dry-run 一个控制器动作；每次有效 dispatch 都会写入操作记录并通过 SSE 广播，即使连续运行没有启动。
- `POST /api/jev/systemone`：TypeSafe System One 代理。

`obs-decide` 请求示例：

```json
{
  "game": "Nintendo Switch 游戏",
  "objective": "解开机关并避开敌人",
  "stateNotes": "角色刚进入关卡，生命值充足",
  "candidates": [
    {"id":"wait","button":"WAIT","description":"等待并观察"},
    {"id":"a","buttons":["A"],"description":"确认/交互"},
    {"id":"b","button":"B","description":"当前游戏中的次要动作"}
  ]
}
```

`/api/game/decide` 和 `/api/game/obs-decide` 可以接收这些通用字段：`game`、`gameIntroduction`、`controller`、`gameplay`、`controls`、`observations`、`objective`、`stateNotes` 和 `candidates`。视觉管线固定为 OmniJev 原始视觉。
