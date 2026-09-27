import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { controllerStatus, dispatchControllerAction } from "./controller.mjs";
import { listProfiles, recordControllerAction, runtimeStatus, startRuntime, stopRuntime, subscribeRuntime } from "./runtime.mjs";

// A browser or proxy can close an HTTP/SSE socket while a response is being
// flushed. Node reports that as an uncaught EPIPE on the socket; it is safe to
// ignore because the peer is already gone, while preserving all other errors.
process.on("uncaughtException", (error) => {
  if (error?.code === "EPIPE") return;
  throw error;
});

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const jevProvider = (process.env.JEV_PROVIDER || "local").trim().toLowerCase();
const baseUrl = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
const apiKey = (process.env.TYPESAFE_API_KEY || "").trim();
const localJevBaseUrl = (process.env.LOCAL_JEV_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
const localJevPath = process.env.LOCAL_JEV_PATH || "/v1/judge";
const jevRequestTimeoutMs = Math.max(1000, Number(process.env.JEV_REQUEST_TIMEOUT_MS || 30000));
const maxBodyBytes = 6 * 1024 * 1024;
const dashboard = await readFile(new URL("../public/index.html", import.meta.url));
const evidenceSheetScript = new URL("./evidence_sheet.py", import.meta.url).pathname;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("request body exceeds 6 MiB");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

async function callJev(path, body) {
  if (!apiKey) throw Object.assign(new Error("TYPESAFE_API_KEY is not configured"), { statusCode: 503 });
  const response = await fetch(`${baseUrl}/v1/systemone`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  return { response, data };
}

async function callLocalJev({ imageData, memoryImages = [], instructions, criteria }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), jevRequestTimeoutMs);
  const requestBody = JSON.stringify({
    image: imageData,
    memory_images: Array.isArray(memoryImages) ? memoryImages : [],
    questions: { action: { type: "choice", instructions, criteria } },
  });
  const started = performance.now();
  try {
    const response = await fetch(`${localJevBaseUrl}${localJevPath.startsWith("/") ? localJevPath : `/${localJevPath}`}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: requestBody,
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    return { response, data, requestBytes: Buffer.byteLength(requestBody), transportMs: performance.now() - started };
  } catch (error) {
    if (error.name === "AbortError") {
      throw Object.assign(new Error(`Local Jev request timed out after ${jevRequestTimeoutMs} ms`), { statusCode: 504 });
    }
    throw Object.assign(new Error(`Cannot reach local Jev at ${localJevBaseUrl}${localJevPath}: ${error.message}`), { statusCode: 503 });
  } finally {
    clearTimeout(timer);
  }
}

async function composeEvidenceSheet(imageData, memoryImages) {
  if (!Array.isArray(memoryImages) || memoryImages.length === 0) return imageData;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || "python3", [evidenceSheetScript], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `evidence sheet exited with code ${code}`));
      const result = stdout.trim();
      if (!result.startsWith("data:image/")) return reject(new Error("evidence sheet returned invalid image data"));
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ image: imageData, memory_images: memoryImages }));
  });
}

function obsAuthentication(password, salt, challenge) {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

async function captureObsScreenshot({ width = 1280 } = {}) {
  const wsUrl = process.env.OBS_WS_URL || "ws://127.0.0.1:4455";
  const sourceName = process.env.OBS_SOURCE_NAME;
  if (!sourceName) throw Object.assign(new Error("OBS_SOURCE_NAME is not configured"), { statusCode: 503 });
  if (typeof WebSocket === "undefined") throw Object.assign(new Error("Node.js WebSocket client is unavailable"), { statusCode: 500 });

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const requestId = randomUUID();
    const timer = setTimeout(() => finish(new Error("OBS WebSocket timed out")), 15000);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      error ? reject(Object.assign(error, { statusCode: error.statusCode || 502 })) : resolve(value);
    };
    ws.addEventListener("error", () => finish(new Error("Cannot connect to OBS WebSocket; check that WebSocket Server is enabled in OBS")));
    ws.addEventListener("close", () => { if (!settled) finish(new Error("OBS WebSocket closed before the screenshot arrived")); });
    ws.addEventListener("message", async (event) => {
      try {
        const message = JSON.parse(typeof event.data === "string" ? event.data : await event.data.text());
        if (message.op === 0) {
          const hello = message.d;
          const password = process.env.OBS_WS_PASSWORD || "";
          const identify = { rpcVersion: hello.rpcVersion };
          if (hello.authentication) identify.authentication = obsAuthentication(password, hello.authentication.salt, hello.authentication.challenge);
          ws.send(JSON.stringify({ op: 1, d: identify }));
        } else if (message.op === 2) {
          ws.send(JSON.stringify({ op: 6, d: { requestType: "GetSourceScreenshot", requestId, requestData: { sourceName, imageFormat: "png", imageWidth: width } } }));
        } else if (message.op === 7 && message.d.requestId === requestId) {
          if (!message.d.requestStatus?.result) throw new Error(message.d.requestStatus?.comment || "OBS screenshot request failed");
          const imageData = message.d.responseData?.imageData;
          if (typeof imageData !== "string" || !imageData.startsWith("data:image/")) throw new Error("OBS returned no screenshot image data");
          finish(null, { sourceName, imageData, capturedAt: new Date().toISOString() });
        }
      } catch (error) { finish(error); }
    });
  });
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 12) {
    throw Object.assign(new Error("candidates must contain 2 to 12 legal actions"), { statusCode: 400 });
  }
  const ids = new Set();
  for (const item of candidates) {
    const hasButton = typeof item?.button === "string" && item.button.trim();
    const hasButtons = Array.isArray(item?.buttons) && item.buttons.length > 0
      && item.buttons.every((button) => typeof button === "string" && button.trim());
    if (!item || typeof item.id !== "string" || (!hasButton && !hasButtons) || typeof item.description !== "string" || ids.has(item.id)) {
      throw Object.assign(new Error("each candidate needs a unique id, button or buttons, and description"), { statusCode: 400 });
    }
    ids.add(item.id);
  }
}

function omniVisualState() {
  return {
    vision_pipeline: "omnijev",
    image_source: "raw_capture_frame",
  };
}

function compactText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.62);
  const tail = Math.max(0, limit - head - 3);
  return `${text.slice(0, head)}...${tail ? text.slice(-tail) : ""}`;
}

async function recommendGameAction({ game, gameIntroduction, controls, controller, gameplay, observations, objective, stateNotes, state, imageData, memoryImages = [], candidates }) {
  // The local decision head scores every candidate label in a batched suffix
  // pass. Keep labels semantic but short so descriptions and timing metadata
  // do not become extra visual-language tokens on every branch.
  const criteria = Object.fromEntries(candidates.map(({ id, intent, when_to_use, description }) => {
    const semantic = intent || when_to_use || description || id;
    return [id, `${id}: ${compactText(semantic, 48)}`];
  }));
  const configInstructions = `Game: ${compactText(game, 72)}. Goal: ${compactText(objective, 96)}. Safety: ${compactText(stateNotes, 140)}.`;
  const memoryInstructions = memoryImages.length
    ? ` The image is a temporal evidence sheet: older frames are included before the newest frame. Compare the same image positions across frames and retain features that were visible earlier in this round.`
    : "";
  const activeRoundNoWait = String(stateNotes || "").includes("活动关卡禁止 WAIT") || String(stateNotes || "").includes("活动关卡不能 WAIT");
  const waitRule = activeRoundNoWait
    ? "In menus, loading, or results choose WAIT. During an active round, never choose WAIT; choose one movement candidate."
    : "In menus, loading, results, or genuine uncertainty choose WAIT.";
  const instructions = jevProvider === "local"
    ? `Inspect the raw game screenshot.${memoryInstructions} ${configInstructions} Choose one supplied candidate id exactly; its label contains the action semantics. ${waitRule} Do not explain.`
    : `Choose one short next action from the supplied screenshot. ${configInstructions} Choose only a supplied legal action. ${waitRule}`;
  const jevState = jevProvider === "local" ? null : {
    game,
    game_config: {
      introduction: gameIntroduction || "",
      controls: controls && typeof controls === "object" && !Array.isArray(controls) ? controls : {},
      controller: controller && typeof controller === "object" && !Array.isArray(controller) ? controller : {},
      gameplay: gameplay && typeof gameplay === "object" && !Array.isArray(gameplay) ? gameplay : {},
      observations: observations && typeof observations === "object" && !Array.isArray(observations) ? observations : {},
    },
    objective,
    player_context: stateNotes || "",
    observation: state,
    legal_actions: candidates,
  };
  const questions = { action: {
    type: "choice",
    instructions,
    criteria,
  } };
  const decisionStarted = performance.now();
  const evidenceImage = memoryImages.length ? await composeEvidenceSheet(imageData, memoryImages) : imageData;
  const localResult = jevProvider === "local"
    ? await callLocalJev({ imageData: evidenceImage, instructions, criteria })
    : null;
  const { response, data } = localResult || await callJev("systemone", { state: jevState, model: "jev-latest", questions });
  if (!response.ok) throw Object.assign(new Error(`Jev HTTP ${response.status}: ${data.message || data.error || "request failed"}`), { statusCode: response.status });
  const answer = data?.answers?.action;
  const candidate = candidates.find(({ id }) => id === answer?.choice);
  if (!candidate) throw Object.assign(new Error("Jev response did not select one of the supplied legal actions"), { statusCode: 502 });
  const probabilities = answer.probabilities ?? null;
  const confidence = answer.confidence ?? answer.concentration ?? (probabilities ? Math.max(...Object.values(probabilities).map(Number)) : null);
  const metrics = data.metrics ? { ...data.metrics } : {};
  if (localResult) {
    metrics.gateway_elapsed_ms = Math.round((performance.now() - decisionStarted) * 10) / 10;
    metrics.jev_transport_ms = Math.round(localResult.transportMs * 10) / 10;
    metrics.jev_request_bytes = localResult.requestBytes;
    metrics.model_elapsed_ms = data.metrics?.elapsed_ms ?? null;
  }
  return { candidate, confidence, probabilities, model: data.model ?? data.model_source ?? null, provider: jevProvider, metrics };
}

let lastObsJevRequestAt = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(dashboard);
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true, service: "luffy-jev-gateway", jevProvider, jevConfigured: jevProvider === "local" ? Boolean(localJevBaseUrl) : Boolean(apiKey), jevEndpoint: jevProvider === "local" ? `${localJevBaseUrl}${localJevPath}` : `${baseUrl}/v1/systemone`, visionPipeline: "omnijev", controller: controllerStatus(), obsScreenshotConfigured: Boolean(process.env.OBS_SOURCE_NAME), obsAuthenticationConfigured: Boolean(process.env.OBS_WS_PASSWORD) });
  }
  if (req.method === "GET" && url.pathname === "/api/profiles") {
    try { return json(res, 200, { profiles: await listProfiles() }); }
    catch (error) { return json(res, error.statusCode || 500, { error: error.message }); }
  }
  if (req.method === "GET" && url.pathname === "/api/runtime/status") {
    return json(res, 200, runtimeStatus());
  }
  if (req.method === "GET" && url.pathname === "/api/runtime/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    });
    res.write(`event: ready\ndata: ${JSON.stringify(runtimeStatus())}\n\n`);
    const unsubscribe = subscribeRuntime(res);
    req.on("close", unsubscribe);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/runtime/start") {
    try {
      const body = await readJson(req);
      return json(res, 200, await startRuntime({ profile: body.profile, autoExecute: body.autoExecute !== false }));
    } catch (error) { return json(res, error.statusCode || 502, { error: error.message }); }
  }
  if (req.method === "POST" && url.pathname === "/api/runtime/stop") {
    return json(res, 200, stopRuntime());
  }
  if (req.method === "GET" && url.pathname === "/api/obs/screenshot") {
    try {
      const requestedWidth = Number(url.searchParams.get("width") || 1280);
      const width = Number.isFinite(requestedWidth) ? Math.min(1280, Math.max(320, Math.round(requestedWidth))) : 1280;
      return json(res, 200, await captureObsScreenshot({ width }));
    }
    catch (error) { return json(res, error.statusCode || 502, { error: error.message }); }
  }
  if (req.method === "POST" && (url.pathname === "/api/game/decide" || url.pathname === "/api/fc26/decide")) {
    try {
      const body = await readJson(req);
      if (typeof body.imageData !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(body.imageData)) throw Object.assign(new Error("imageData must be a PNG, JPEG, or WebP data URL"), { statusCode: 400 });
      validateCandidates(body.candidates);
      const state = omniVisualState();
      const memoryImages = Array.isArray(body.memoryImages) ? body.memoryImages.slice(-1) : [];
      const recommendation = await recommendGameAction({ game: body.game || "Unspecified game", gameIntroduction: body.gameIntroduction, controls: body.controls, controller: body.controller, gameplay: body.gameplay, observations: body.observations, objective: body.objective || "Choose a safe next action", stateNotes: body.stateNotes, state, imageData: body.imageData, memoryImages, candidates: body.candidates });
      return json(res, 200, { status: "recommendation", visionPipeline: "omnijev", state, suggestedAction: recommendation.candidate, confidence: recommendation.confidence, probabilities: recommendation.probabilities, model: recommendation.model, provider: recommendation.provider, metrics: recommendation.metrics, execution: "manual_only" });
    } catch (error) {
      return json(res, error.statusCode || (error.name === "TypeError" ? 502 : 400), { error: error.message || "request_failed" });
    }
  }
  if (req.method === "POST" && ["/api/game/obs-decide", "/api/fc26/obs-decide"].includes(url.pathname)) {
    try {
      const body = await readJson(req);
      validateCandidates(body.candidates);
      const frame = await captureObsScreenshot();
      const state = omniVisualState();
      const jevInterval = Math.max(1000, Number(process.env.JEV_MIN_INTERVAL_MS || 2500));
      if (Date.now() - lastObsJevRequestAt < jevInterval) {
        return json(res, 200, { status: "pending", reason: "jev_request_cooldown", sourceName: frame.sourceName, capturedAt: frame.capturedAt, imageData: frame.imageData, state, suggestedAction: null, execution: "manual_only" });
      }
      lastObsJevRequestAt = Date.now();
      const recommendation = await recommendGameAction({ game: body.game || "Unspecified game", gameIntroduction: body.gameIntroduction, controls: body.controls, controller: body.controller, gameplay: body.gameplay, observations: body.observations, objective: body.objective || "Choose a safe next action", stateNotes: body.stateNotes, state, imageData: frame.imageData, candidates: body.candidates });
      return json(res, 200, { status: "recommendation", visionPipeline: "omnijev", sourceName: frame.sourceName, capturedAt: frame.capturedAt, imageData: frame.imageData, state, suggestedAction: recommendation.candidate, confidence: recommendation.confidence, probabilities: recommendation.probabilities, model: recommendation.model, provider: recommendation.provider, metrics: recommendation.metrics, execution: "manual_only" });
    } catch (error) {
      if ((error.message || "").includes("OBS WebSocket")) await new Promise((resolve) => setTimeout(resolve, 1000));
      return json(res, error.statusCode || (error.name === "TypeError" ? 502 : 400), { error: error.message || "request_failed" });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/controller/dispatch") {
    let body = {};
    let source = "api";
    try {
      body = await readJson(req);
      source = body.source || source;
      const result = await dispatchControllerAction(body.action, { durationMs: body.durationMs, source, execute: body.execute !== false });
      const record = recordControllerAction(result.action || body.action, result, source);
      return json(res, 200, { status: result.sent ? "sent" : "dry_run", record, ...result });
    } catch (error) {
      if (body?.action) {
        try {
          const record = recordControllerAction(body.action, { sent: false, error: error.message }, source);
          return json(res, error.statusCode || 502, { error: error.message || "controller_dispatch_failed", record });
        } catch {
          // Preserve the original dispatch error even if an invalid action cannot be recorded.
        }
      }
      return json(res, error.statusCode || 502, { error: error.message || "controller_dispatch_failed" });
    }
  }
  if (req.method !== "POST" || url.pathname !== "/api/jev/systemone") {
    return json(res, 404, { error: "not_found" });
  }

  try {
    const body = await readJson(req);
    const { response, data } = await callJev("systemone", body);
    return json(res, response.status, data);
  } catch (error) {
    const status = error.statusCode || (error.name === "TypeError" ? 502 : 400);
    return json(res, status, { error: error.message || "request_failed" });
  }
});

server.listen(port, host, () => {
  console.log(`luffy Jev gateway listening on http://${host}:${port}`);
});
