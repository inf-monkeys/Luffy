# Luffy: A General-Purpose Intelligent Switch Controller

Luffy is a general-purpose intelligent controller system for Nintendo Switch. It captures the Switch display, runs a local vision model on a Mac mini, selects a legal action from the active game profile, executes that action through a Pico 2 W emulated controller, and records decision and operation logs.

## Technical workflow

```text
Pico 2 W Raspberry Pi controller emulation
        ↓
Switch display capture (capture card / OBS)
        ↓
Local vision inference on Mac mini
        ↓
Action decision and safety checks
        ↓
Wi-Fi UDP → Pico 2 W → USB HID → Switch
        ↓
Decision, latency, send status, and action logs
```

- **Pico 2 W controller emulation**: Uses [Pico2W-Switch-Agent](https://github.com/inf-monkeys/Pico2W-Switch-Agent), our Wi-Fi version of a Switch Pro controller firmware adapted from the open-source [`switch-pico`](https://github.com/jyapayne/switch-pico) project. It receives complete controller states and exposes them to the Switch over USB HID.
- **Switch display capture**: The browser uses `MediaStream` to display a capture card or OBS Virtual Camera. The backend uses OBS WebSocket to obtain decision frames. Preview and inference capture remain independent.
- **Mac mini inference**: The default model is [Ruiruiz30/OmniJev-MLX-5bit](https://huggingface.co/Ruiruiz30/OmniJev-MLX-5bit), our team's MLX inference adaptation, decision-head integration, and 5-bit quantization of [`tinnel123/OmniJev`](https://huggingface.co/tinnel123/OmniJev).
- **Action execution and logging**: The model can only select from legal candidate actions declared by the active profile. Confidence, runtime state, and controller mode are checked before an action is sent to the Pico 2 W. Model decisions, manual input, gateway dispatches, controller send results, and runtime timings are written to the same behavior log.

The default configuration uses local inference and `dry-run` controller mode. Actions are sent to the Pico 2 W only when automatic execution is explicitly enabled and the controller mode is set to `udp`. Errors, low confidence, and stopped runs return the controller to `WAIT` / neutral state.

## Quick start

```bash
cp .env.example .env
npm run check
npm start
```

Open <http://127.0.0.1:8787> and allow the browser to access video devices. If the capture card is occupied by OBS, start OBS Virtual Camera and select it on the page. OBS WebSocket uses `ws://127.0.0.1:4455` by default; keep authentication enabled and set the password and source name in `.env`.

The gateway listens on `127.0.0.1:8787` by default. Start the local OmniJev inference service separately:

```bash
"/Users/leo/WorkSpace/Luffy/jev-omni-venv/bin/uvicorn" \
  jev_omni_server:app --app-dir src --host 127.0.0.1 --port 8788
```

Confirm that `http://127.0.0.1:8788/health` returns `ready: true` before starting the Luffy gateway. Override the model directory, decision head, and input pixel budget with `JEV_OMNI_MODEL_PATH`, `JEV_OMNI_HEAD_PATH`, and `JEV_OMNI_MAX_PIXELS`.

## Video preview and real-time operation

The first screen shows the capture-card video, a manual Switch controller, and the behavior log together. When you click **Start automatic execution**, the backend samples frames at the configured interval, calls `/api/game/decide`, and sends actions that pass the safety checks to the Pico 2 W. Clicking **Stop** ends the run and returns the controller to neutral.

The default inference input is `87,808` pixels. Runtime logs include total elapsed time, model time, and Jev HTTP round-trip time so that model latency can be distinguished from service latency. Mouse, touch, stick, and keyboard input (`WASD`, arrow keys, `ABXY`, and `Q/E`) all use the same controller dispatch path and appear in the same behavior log.

## Continuous operation and game profiles

`live:drive` is the general-purpose runtime. It continuously captures frames, calls `/api/game/decide`, and sends suggestions above the confidence threshold to the Pico. Game rules are not hard-coded in the core runtime. The game name, introduction, objective, controller protocol, gameplay state, observations, capture settings, and legal actions come from `*.json` profiles under `profiles/`.

The default profile is `profiles/switch-generic.json`, which is useful for checking the pipeline and navigating menus. The racing experiment profile is `profiles/mario-kart-world.json`. To add a game, copy a profile and fill in the fields required by the schema and the candidate actions.

Every profile must declare `schema_version: 1` and conform to [`profiles/game-profile.schema.json`](profiles/game-profile.schema.json). The core fields are:

- `introduction`, `objective`, and `state_notes`: game context, current objective, and decision boundaries.
- `controller` and `gameplay`: controller capabilities, runtime states, and completion signals.
- `controls`: the meaning and usage of standard Switch Pro buttons, the D-pad, sticks, and `WAIT`.
- `observations`: the elements the model should read from the display.
- `candidates`: the finite set of actions the model may select; sticks use `-1..1` coordinates and `duration_ms` specifies the hold time.

Run a small validation pass with:

```bash
LUFFY_PROFILE=mario-kart-world \
MAX_STEPS=3 \
DECISION_INTERVAL_MS=1200 \
ACTION_DURATION_MS=1000 \
MIN_ACTION_CONFIDENCE=0.65 \
npm run live:drive
```

## Controller output

Set `CONTROLLER_MODE` to choose the output path:

- `manual`: record actions without sending them to a device.
- `http`: send actions to the HTTP endpoint configured by `CONTROLLER_BASE_URL`.
- `udp`: send action JSON to the Pico 2 W at `192.168.4.1:8765`.

The generic action format is:

```json
{
  "action": {
    "id": "a",
    "buttons": ["A", "ZR"],
    "left_stick": {"x": 0.0, "y": 0.0},
    "right_stick": {"x": 0.0, "y": 0.0},
    "description": "Confirm / interact",
    "duration_ms": 120
  },
  "source": "operator"
}
```

The Pico firmware holds the complete controller state for `duration_ms` and then returns to neutral automatically. The current hardware has no gyroscope, accelerometer, or rumble feedback, so those capabilities remain neutral or are ignored.
