import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { controllerStatus } from "./controller.mjs";
import { findProfileFiles } from "./profile_files.mjs";
import { validateGameProfile } from "./profile_schema.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const profilesDirectory = join(projectRoot, "profiles");
const driverScript = join(projectRoot, "scripts", "live_driver.mjs");
const events = new EventEmitter();
const history = [];
const maxHistory = 500;

let child = null;
let runtime = {
  running: false,
  profile: null,
  autoExecute: false,
  pid: null,
  startedAt: null,
  lastAction: null,
  lastMessage: null,
  exit: null,
};

function runtimeError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function addEvent(event) {
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), ...event };
  history.push(item);
  if (history.length > maxHistory) history.shift();
  events.emit("event", item);
  return item;
}

function parseLine(line, stream = "stdout") {
  const action = line.match(/step=(\d+) action=([^ ]+) confidence=([^ ]+) sent=(true|false) elapsed=(\d+)ms(?: model=(\d+)ms)?(?: jev=(\d+)ms)?/);
  if (action) {
    const event = {
      type: "action",
      step: Number(action[1]),
      action: action[2],
      confidence: action[3] === "n/a" ? null : Number(action[3]),
      sent: action[4] === "true",
      elapsedMs: Number(action[5]),
      modelElapsedMs: action[6] === undefined ? null : Number(action[6]),
      jevTransportMs: action[7] === undefined ? null : Number(action[7]),
      message: line,
    };
    runtime.lastAction = event;
    return addEvent(event);
  }
  return addEvent({ type: stream === "stderr" ? "error" : "log", message: line });
}

function attachOutput(stream, name) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) if (line.trim()) {
      runtime.lastMessage = line;
      parseLine(line, name);
    }
  });
  stream.on("end", () => {
    if (pending.trim()) parseLine(pending, name);
  });
}

function validateProfileId(profile) {
  if (typeof profile !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(profile)) {
    throw runtimeError("profile must be a profile id such as switch-generic", 400);
  }
  return profile;
}

async function loadProfileEntries() {
  const files = await findProfileFiles(profilesDirectory);
  const profiles = [];
  for (const file of files) {
    try {
      const profile = validateGameProfile(JSON.parse(await readFile(file.absolutePath, "utf8")), { source: file.relativePath });
      profiles.push({ profile, file });
    } catch (error) {
      addEvent({ type: "error", message: `Unable to load profile ${file.relativePath}: ${error.message}` });
    }
  }
  return profiles;
}

export async function listProfiles() {
  return (await loadProfileEntries()).map(({ profile }) => profile);
}

export function recordControllerAction(action, result = {}, source = "api") {
  const buttons = Array.isArray(action?.buttons)
    ? action.buttons.filter((button) => typeof button === "string" && button.trim()).map((button) => button.trim().toUpperCase())
    : typeof action?.button === "string" ? [action.button.trim().toUpperCase()] : ["WAIT"];
  const leftStick = action?.left_stick ?? action?.leftStick ?? null;
  const rightStick = action?.right_stick ?? action?.rightStick ?? null;
  const driverActionId = source === "live-driver" && typeof action?.id === "string"
    && !["live-driver-abstain", "live-driver-stop"].includes(action.id) ? action.id : null;
  const stickLabel = leftStick && (Math.abs(Number(leftStick.x || 0)) > 0.02 || Math.abs(Number(leftStick.y || 0)) > 0.02)
    ? `LEFT_STICK(${Number(leftStick.x || 0).toFixed(2)},${Number(leftStick.y || 0).toFixed(2)})` : null;
  const buttonLabel = buttons.filter((button) => button !== "WAIT").join(" + ");
  const item = addEvent({
    type: "action",
    action: driverActionId || stickLabel || buttonLabel || "WAIT",
    id: typeof action?.id === "string" ? action.id : null,
    buttons,
    left_stick: leftStick,
    right_stick: rightStick,
    durationMs: Number(action?.duration_ms ?? action?.durationMs ?? 0),
    source,
    sent: result.sent === true,
    endpoint: result.endpoint || null,
    description: typeof action?.description === "string" ? action.description : "",
    message: result.sent === true ? `Controller action sent (${source})` : `Controller action recorded (${source})`,
  });
  runtime.lastAction = item;
  return item;
}

export function runtimeStatus() {
  return {
    ...runtime,
    controller: controllerStatus(),
    history: history.slice(-500),
  };
}

export function subscribeRuntime(res) {
  let closed = false;
  let heartbeat;
  let listener;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    events.off("event", listener);
  };
  const send = (event) => {
    if (closed || res.destroyed || res.writableEnded) return;
    try { res.write(`event: ${event.type || "runtime"}\ndata: ${JSON.stringify(event)}\n\n`); }
    catch { cleanup(); }
  };
  for (const item of history.slice(-500)) send(item);
  listener = (item) => send(item);
  events.on("event", listener);
  heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
  res.once("close", cleanup);
  res.once("error", cleanup);
  return cleanup;
}

export async function startRuntime({ profile = "switch-generic", autoExecute = true } = {}) {
  if (child) throw runtimeError("Luffy runtime is already running", 409);
  const profileId = validateProfileId(profile);
  const profiles = await loadProfileEntries();
  const selectedProfile = profiles.find(({ profile: item }) => item.id === profileId);
  if (!selectedProfile) throw runtimeError(`Unknown Luffy profile: ${profileId}`, 404);
  const env = {
    ...process.env,
    LUFFY_PROFILE: profileId,
    LUFFY_PROFILE_PATH: selectedProfile.file.absolutePath,
  };
  env.LUFFY_AUTO_EXECUTE = autoExecute ? "true" : "false";
  child = spawn(process.execPath, [driverScript], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtime = {
    running: true,
    profile: profileId,
    autoExecute: Boolean(autoExecute),
    pid: child.pid,
    startedAt: new Date().toISOString(),
    lastAction: null,
    lastMessage: null,
    exit: null,
  };
  addEvent({ type: "started", profile: profileId, visionPipeline: "omnijev", autoExecute: Boolean(autoExecute), controller: controllerStatus(), message: `Started ${profileId}` });
  attachOutput(child.stdout, "stdout");
  attachOutput(child.stderr, "stderr");
  child.once("error", (error) => addEvent({ type: "error", message: `Runtime process error: ${error.message}` }));
  child.once("close", (code, signal) => {
    const exit = { code, signal };
    runtime = { ...runtime, running: false, pid: null, exit };
    child = null;
    addEvent({ type: "stopped", ...exit, message: `Runtime stopped${signal ? ` (${signal})` : ""}` });
  });
  return runtimeStatus();
}

export function stopRuntime() {
  if (!child) return runtimeStatus();
  addEvent({ type: "stopping", message: "Stopping runtime and sending neutral state" });
  child.kill("SIGINT");
  return runtimeStatus();
}
