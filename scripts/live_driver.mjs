import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findProfileFiles } from "../src/profile_files.mjs";
import { validateGameProfile } from "../src/profile_schema.mjs";

const luffyBaseUrl = (process.env.LUFFY_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const profileName = process.env.LUFFY_PROFILE || "switch-generic";
const profilesDirectory = fileURLToPath(new URL("../profiles/", import.meta.url));

async function resolveProfilePath() {
  if (process.env.LUFFY_PROFILE_PATH) return process.env.LUFFY_PROFILE_PATH;

  const files = await findProfileFiles(profilesDirectory);
  const filenameMatch = files.find(({ relativePath }) => basename(relativePath, ".json") === profileName);
  if (filenameMatch) return filenameMatch.absolutePath;

  for (const file of files) {
    try {
      const candidate = JSON.parse(await readFile(file.absolutePath, "utf8"));
      if (candidate.id === profileName) return file.absolutePath;
    } catch {
      // Validation below reports malformed profiles with their source path.
    }
  }

  return join(profilesDirectory, `${profileName}.json`);
}

const profilePath = await resolveProfilePath();
let profile;
try {
  profile = validateGameProfile(JSON.parse(await readFile(profilePath, "utf8")), { source: profilePath });
} catch (error) {
  throw new Error(`Cannot load Luffy profile ${profileName} from ${profilePath}: ${error.message}`);
}

function parseCandidates() {
  const raw = process.env.LUFFY_CANDIDATES_JSON;
  const parsed = raw ? JSON.parse(raw) : profile.candidates;
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error("Luffy profile must define at least two candidates, or set LUFFY_CANDIDATES_JSON");
  }
  return parsed;
}

const captureDevice = process.env.CAPTURE_DEVICE || profile.capture?.device || "Hagibis";
// CAPTURE_SIZE remains the inference frame size for backwards compatibility
// with existing profiles.  Opening the shared device at that size would make
// the browser's MediaStream switch to the same low-resolution mode.  Capture
// at a high source mode first, then resize only the frames written to stdout.
const inferenceSize = process.env.INFERENCE_SIZE || process.env.CAPTURE_SIZE || profile.capture?.size || "640x480";
const inferenceFramerate = Number(process.env.INFERENCE_FRAMERATE || process.env.CAPTURE_FRAMERATE || profile.capture?.framerate || 10);
const sourceSize = process.env.CAPTURE_SOURCE_SIZE || "1920x1080";
const sourceFramerate = Number(process.env.CAPTURE_SOURCE_FRAMERATE || 30);
const decisionIntervalMs = Math.max(250, Number(process.env.DECISION_INTERVAL_MS || profile.runtime?.decision_interval_ms || 1200));
const actionDurationMs = Math.max(50, Math.min(2000, Number(process.env.ACTION_DURATION_MS || profile.runtime?.action_duration_ms || 1000)));
const minimumActionConfidence = Math.max(0, Math.min(1, Number(process.env.MIN_ACTION_CONFIDENCE || profile.runtime?.min_action_confidence || 0.65)));
const movementSwitchConfirmations = Math.max(1, Math.min(5, Math.round(Number(process.env.MOVEMENT_SWITCH_CONFIRMATIONS || profile.runtime?.movement_switch_confirmations || 1))));
const visualMemoryFrames = Math.max(0, Math.min(2, Math.round(Number(process.env.VISUAL_MEMORY_FRAMES || profile.runtime?.visual_memory_frames || 2))));
const mustAnswer = profile.runtime?.must_answer_before_timeout === true;
const forceAnswerAfterWaits = Math.max(1, Math.round(Number(profile.runtime?.force_answer_after_waits || 10)));
const autoExecute = process.env.LUFFY_AUTO_EXECUTE !== "false";
const jevProvider = (process.env.JEV_PROVIDER || "local").trim().toLowerCase();
const sendFullProviderContext = jevProvider !== "local";
const maxSteps = Math.max(0, Number(process.env.MAX_STEPS || 0));
const game = process.env.LUFFY_GAME || profile.game || "Unspecified Nintendo Switch game";
const gameIntroduction = process.env.LUFFY_GAME_INTRO || profile.introduction || profile.description || "";
const objective = process.env.LUFFY_OBJECTIVE || profile.objective || "Choose a safe next action from the supplied legal actions.";
const stateNotes = process.env.LUFFY_STATE_NOTES || profile.state_notes || "Use short inputs. WAIT means keep the controller neutral.";
let controls = profile.controls && typeof profile.controls === "object" ? profile.controls : {};
if (process.env.LUFFY_CONTROLS_JSON) controls = JSON.parse(process.env.LUFFY_CONTROLS_JSON);
const controller = profile.controller || {};
const gameplay = profile.gameplay || {};
const observations = profile.observations || {};
const candidates = parseCandidates();
let activeMovementSide = null;
let pendingMovementSide = null;
let pendingMovementCount = 0;
let consecutiveWaits = 0;
let visualMemory = [];
let uncertainWaits = 0;
let stopping = false;

function movementSide(action) {
  const stick = action?.left_stick ?? action?.leftStick;
  if (!stick || typeof stick !== "object") return null;
  const x = Number(stick.x || 0);
  const y = Number(stick.y || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || (Math.abs(x) < 0.05 && Math.abs(y) < 0.05)) return null;
  if (x < -0.05) return "left";
  if (x > 0.05) return "right";
  return "forward";
}

function stabilizeMovementAction(action) {
  const side = movementSide(action);
  if (!side) {
    if (action?.id === "wait") {
      consecutiveWaits += 1;
      pendingMovementSide = null;
      pendingMovementCount = 0;
      if (consecutiveWaits >= movementSwitchConfirmations) activeMovementSide = null;
    }
    return action;
  }

  consecutiveWaits = 0;
  if (!activeMovementSide || side === activeMovementSide) {
    activeMovementSide = side;
    pendingMovementSide = null;
    pendingMovementCount = 0;
    return action;
  }

  if (pendingMovementSide === side) pendingMovementCount += 1;
  else {
    pendingMovementSide = side;
    pendingMovementCount = 1;
  }
  if (pendingMovementCount < movementSwitchConfirmations) {
    const held = candidates.find((candidate) => movementSide(candidate) === activeMovementSide);
    return held || action;
  }

  activeMovementSide = side;
  pendingMovementSide = null;
  pendingMovementCount = 0;
  return action;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CaptureStream {
  constructor() {
    const [inferenceWidth, inferenceHeight] = inferenceSize.split("x").map(Number);
    if (!Number.isInteger(inferenceWidth) || !Number.isInteger(inferenceHeight) || inferenceWidth < 2 || inferenceHeight < 2) {
      throw new Error(`Invalid inference size ${inferenceSize}; expected WIDTHxHEIGHT`);
    }
    const [sourceWidth, sourceHeight] = sourceSize.split("x").map(Number);
    if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 2 || sourceHeight < 2) {
      throw new Error(`Invalid capture source size ${sourceSize}; expected WIDTHxHEIGHT`);
    }
    if (!Number.isFinite(sourceFramerate) || sourceFramerate <= 0) {
      throw new Error(`Invalid capture source framerate ${sourceFramerate}`);
    }
    if (!Number.isFinite(inferenceFramerate) || inferenceFramerate <= 0) {
      throw new Error(`Invalid inference framerate ${inferenceFramerate}`);
    }
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "avfoundation", "-framerate", String(sourceFramerate),
      "-video_size", sourceSize, "-i", `${captureDevice}:none`,
      "-vf", `scale=${inferenceWidth}:${inferenceHeight}:flags=lanczos,fps=${inferenceFramerate}`,
      "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "pipe:1",
    ];
    this.child = spawn(process.env.FFMPEG_BIN || "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.buffer = Buffer.alloc(0);
    this.latestFrame = null;
    this.waiter = null;
    this.failure = null;
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.on("error", (error) => this.#fail(error));
    this.child.on("close", (code) => {
      if (code !== 0 && !this.failure) this.#fail(new Error(`capture stream exited with code ${code}`));
    });
  }

  #fail(error) {
    this.failure = error;
    if (this.waiter) {
      this.waiter.reject(error);
      this.waiter = null;
    }
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let last = null;
    while (true) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        break;
      }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        break;
      }
      last = this.buffer.subarray(start, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
    }
    if (last) {
      this.latestFrame = last;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        const frame = this.latestFrame;
        this.latestFrame = null;
        waiter.resolve(frame);
      }
    }
  }

  next(timeoutMs = 3000) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.latestFrame) {
      const frame = this.latestFrame;
      this.latestFrame = null;
      return Promise.resolve(frame);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        if (this.waiter === waiter) this.waiter = null;
        reject(new Error("capture stream timed out waiting for a frame"));
      }, timeoutMs);
      this.waiter = waiter;
    });
  }

  stop() {
    if (!this.child.killed) this.child.kill("SIGTERM");
  }
}

async function postJson(path, body, timeoutMs = 30000) {
  let response;
  try {
    response = await fetch(`${luffyBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`${path} request timed out after ${timeoutMs} ms`);
    }
    throw new Error(`${path} request failed: ${error.message}`);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function dispatch(action, source) {
  const requestedDuration = action?.duration_ms ?? action?.durationMs;
  const durationMs = requestedDuration === undefined ? actionDurationMs : requestedDuration;
  return postJson("/api/controller/dispatch", {
    action,
    durationMs,
    execute: autoExecute,
    source,
  }, 5000);
}

async function sendNeutral() {
  try {
    await dispatch({ id: "live-driver-stop", buttons: ["WAIT"] }, "live-driver-stop");
  } catch (error) {
    console.error(`[live-driver] failed to send neutral: ${error.message}`);
  }
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[live-driver] ${signal}; sending neutral state and stopping`);
  await sendNeutral();
  if (capture) capture.stop();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

console.log(`[live-driver] ${game} · capture=${captureDevice} source=${sourceSize}@${sourceFramerate} inference=${inferenceSize}@${inferenceFramerate} · interval=${decisionIntervalMs}ms · action=${actionDurationMs}ms · switch-confirm=${movementSwitchConfirmations} · vision=omnijev · execute=${autoExecute}`);
console.log(`[live-driver] candidates=${candidates.map((item) => item.id).join(", ")}`);

let capture = new CaptureStream();
let step = 0;
while (!stopping && (!maxSteps || step < maxSteps)) {
  step += 1;
  const started = performance.now();
  try {
    const frame = await capture.next();
    const imageData = `data:image/jpeg;base64,${frame.toString("base64")}`;
    if (visualMemoryFrames > 0) {
      visualMemory.push(imageData);
      if (visualMemory.length > visualMemoryFrames) visualMemory.shift();
    }
    const decisionRequest = {
      game,
      objective,
      stateNotes,
      imageData,
      memoryImages: visualMemory.slice(0, -1),
      candidates,
    };
    if (sendFullProviderContext) {
      Object.assign(decisionRequest, { gameIntroduction, controls, controller, gameplay, observations });
    }
    const decision = await postJson("/api/game/decide", decisionRequest);

    let action;
    let label;
    const confidentRecommendation = decision.status === "recommendation" && Number(decision.confidence || 0) >= minimumActionConfidence;
    const hasVisualEvidence = visualMemory.length >= Math.min(2, Math.max(1, visualMemoryFrames));
    const forceAnswer = mustAnswer && hasVisualEvidence && uncertainWaits >= forceAnswerAfterWaits;
    if (confidentRecommendation || forceAnswer) {
      const suggestedAction = decision.suggestedAction;
      let forcedAction = suggestedAction;
      if (forceAnswer && (!forcedAction || forcedAction.id === "wait" || forcedAction.buttons?.includes("WAIT"))) {
        const probabilities = decision.probabilities || {};
        const answerCandidates = candidates.filter((candidate) => candidate.id !== "wait" && !candidate.buttons?.includes("WAIT"));
        forcedAction = answerCandidates.slice().sort((a, b) => Number(probabilities[b.id] || 0) - Number(probabilities[a.id] || 0))[0] || answerCandidates[0];
      }
      action = stabilizeMovementAction(forcedAction);
      label = `${action.id} confidence=${Number(decision.confidence).toFixed(3)}`;
      uncertainWaits = 0;
    } else {
      action = { id: "live-driver-abstain", buttons: ["WAIT"], description: decision.reason || "low-confidence decision" };
      label = `${decision.status || "abstain"} confidence=${decision.confidence ?? "n/a"}`;
      uncertainWaits += 1;
    }
    const sent = await dispatch(action, "live-driver");
    if (action.id !== "wait" && !action.buttons?.includes("WAIT")) visualMemory = [];
    const elapsed = Math.round(performance.now() - started);
    const modelMs = Number(decision.metrics?.model_elapsed_ms ?? decision.metrics?.elapsed_ms);
    const transportMs = Number(decision.metrics?.jev_transport_ms);
    const timing = [
      Number.isFinite(modelMs) ? `model=${Math.round(modelMs)}ms` : "",
      Number.isFinite(transportMs) ? `jev=${Math.round(transportMs)}ms` : "",
    ].filter(Boolean).join(" ");
    console.log(`[live-driver] step=${step} action=${label} sent=${sent.sent} elapsed=${elapsed}ms${timing ? ` ${timing}` : ""}`);
  } catch (error) {
    console.error(`[live-driver] step=${step} error=${error.message}; sending neutral`);
    if (error.message.includes("/api/game/decide request timed out")) {
      console.error("[live-driver] Jev decision circuit breaker opened; stopping to avoid queued requests");
      await stop("Jev decision timeout");
    }
    await sendNeutral();
  }

  const waitMs = Math.max(0, decisionIntervalMs - (performance.now() - started));
  if (waitMs) await sleep(waitMs);
}

await sendNeutral();
capture.stop();
console.log(`[live-driver] completed steps=${step}`);
