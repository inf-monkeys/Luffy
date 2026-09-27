import dgram from "node:dgram";

const controllerMode = (process.env.CONTROLLER_MODE || "manual").trim().toLowerCase();
const controllerBaseUrl = (process.env.CONTROLLER_BASE_URL || "").replace(/\/$/, "");
const controllerActionPath = process.env.CONTROLLER_ACTION_PATH || "/v1/action";
const controllerRequestTimeoutMs = Math.max(250, Number(process.env.CONTROLLER_REQUEST_TIMEOUT_MS || 3000));
const controllerUdpHost = (process.env.CONTROLLER_UDP_HOST || "192.168.4.1").trim();
const controllerUdpPort = Math.max(1, Math.min(65535, Number(process.env.CONTROLLER_UDP_PORT || 8765)));
const supportedButtons = new Set([
  "A", "B", "X", "Y", "L", "R", "ZL", "ZR", "PLUS", "MINUS",
  "HOME", "CAPTURE", "L3", "R3", "UP", "DOWN", "LEFT", "RIGHT", "WAIT",
]);

function controllerError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function controllerStatus() {
  return {
    mode: controllerMode,
    configured: controllerMode === "manual"
      || (controllerMode === "http" && Boolean(controllerBaseUrl))
      || (controllerMode === "udp" && Boolean(controllerUdpHost)),
    endpoint: controllerMode === "http" && controllerBaseUrl
      ? `${controllerBaseUrl}${controllerActionPath.startsWith("/") ? controllerActionPath : `/${controllerActionPath}`}`
      : controllerMode === "udp" ? `${controllerUdpHost}:${controllerUdpPort}` : null,
  };
}

function sendUdpAction(action, metadata) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const transportAction = {
      buttons: action.buttons,
      left_stick: action.left_stick,
      right_stick: action.right_stick,
      duration_ms: action.duration_ms,
    };
    const payload = Buffer.from(JSON.stringify({
      action: transportAction,
      metadata,
    }));
    const timer = setTimeout(() => {
      socket.close();
      reject(controllerError(`Controller UDP request timed out after ${controllerRequestTimeoutMs} ms`, 504));
    }, controllerRequestTimeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(controllerError(`Cannot send controller UDP action to ${controllerUdpHost}:${controllerUdpPort}: ${error.message}`, 503));
    });
    socket.send(payload, controllerUdpPort, controllerUdpHost, (error) => {
      clearTimeout(timer);
      socket.close();
      if (error) {
        reject(controllerError(`Cannot send controller UDP action to ${controllerUdpHost}:${controllerUdpPort}: ${error.message}`, 503));
        return;
      }
      resolve({ mode: "udp", sent: true, endpoint: `${controllerUdpHost}:${controllerUdpPort}`, bytes: payload.length });
    });
  });
}

function normalizeAction(action, durationMs) {
  if (!action || typeof action !== "object") throw controllerError("action must be an object");
  if (typeof action.id !== "string" || !action.id.trim()) throw controllerError("action.id is required");
  const rawButtons = Array.isArray(action.buttons)
    ? action.buttons
    : typeof action.button === "string" ? [action.button] : [];
  const buttons = rawButtons
    .filter((button) => typeof button === "string" && button.trim())
    .map((button) => button.trim().toUpperCase());
  if (buttons.length === 0) throw controllerError("action.button or action.buttons is required");
  if (buttons.some((button) => !supportedButtons.has(button))) {
    throw controllerError(`Unsupported controller button: ${buttons.find((button) => !supportedButtons.has(button))}`);
  }
  const duration = durationMs ?? action.durationMs ?? action.duration_ms ?? 100;
  if (!Number.isFinite(Number(duration)) || Number(duration) < 0 || Number(duration) > 10000) {
    throw controllerError("durationMs must be between 0 and 10000");
  }
  const normalizeStick = (value, name) => {
    if (value === undefined || value === null) return undefined;
    if (!value || typeof value !== "object") throw controllerError(`${name} must be an object`);
    const x = Number(value.x ?? 0);
    const y = Number(value.y ?? 0);
    if (![x, y].every((axis) => Number.isFinite(axis) && axis >= -1 && axis <= 1)) {
      throw controllerError(`${name}.x and ${name}.y must be between -1 and 1`);
    }
    return { x, y };
  };
  const params = action.params && typeof action.params === "object" ? action.params : {};
  const leftStick = normalizeStick(action.left_stick ?? action.leftStick ?? params.left_stick, "left_stick");
  const rightStick = normalizeStick(action.right_stick ?? action.rightStick ?? params.right_stick, "right_stick");
  return {
    id: action.id,
    button: buttons[0],
    buttons,
    description: typeof action.description === "string" ? action.description : "",
    duration_ms: Math.round(Number(duration)),
    left_stick: leftStick,
    right_stick: rightStick,
    params,
  };
}

async function sendHttpAction(action, metadata) {
  if (!controllerBaseUrl) throw controllerError("CONTROLLER_BASE_URL is not configured", 503);
  const endpoint = `${controllerBaseUrl}${controllerActionPath.startsWith("/") ? controllerActionPath : `/${controllerActionPath}`}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), controllerRequestTimeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ action, metadata }),
      signal: abort.signal,
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!response.ok) throw controllerError(`Controller HTTP ${response.status}: ${data?.message || data?.error || "request failed"}`, 502);
    return { mode: "http", sent: true, endpoint, response: data };
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.name === "AbortError") throw controllerError(`Controller request timed out after ${controllerRequestTimeoutMs} ms`, 504);
    throw controllerError(`Cannot reach controller at ${endpoint}: ${error.message}`, 503);
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchControllerAction(action, { durationMs, source = "manual", execute = true } = {}) {
  const normalized = normalizeAction(action, durationMs);
  const metadata = { source, requested_at: new Date().toISOString() };
  if (!execute) return { mode: "manual", sent: false, reason: "execution_disabled", action: normalized, metadata };
  if (controllerMode === "manual") {
    return { mode: "manual", sent: false, reason: "controller_mode_manual", action: normalized, metadata };
  }
  if (controllerMode === "http") return { ...(await sendHttpAction(normalized, metadata)), action: normalized, metadata };
  if (controllerMode === "udp") return { ...(await sendUdpAction(normalized, metadata)), action: normalized, metadata };
  throw controllerError(`Unsupported CONTROLLER_MODE: ${controllerMode}`, 503);
}
