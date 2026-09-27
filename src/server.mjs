import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const baseUrl = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
const apiKey = (process.env.TYPESAFE_API_KEY || "").trim();
const maxBodyBytes = 6 * 1024 * 1024;
const dashboard = await readFile(new URL("../public/index.html", import.meta.url));

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

function obsAuthentication(password, salt, challenge) {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

async function captureObsScreenshot() {
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
          ws.send(JSON.stringify({ op: 6, d: { requestType: "GetSourceScreenshot", requestId, requestData: { sourceName, imageFormat: "png", imageWidth: 1280 } } }));
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
    if (!item || typeof item.id !== "string" || typeof item.button !== "string" || typeof item.description !== "string" || ids.has(item.id)) {
      throw Object.assign(new Error("each candidate needs a unique id, button, and description"), { statusCode: 400 });
    }
    ids.add(item.id);
  }
}

async function analyzeFrame({ imageData, previousState, previousImageData }) {
  const python = process.env.PYTHON_BIN || new URL("../.venv/bin/python", import.meta.url).pathname;
  const script = new URL("./opencv_perception.py", import.meta.url).pathname;
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(Object.assign(new Error(`Cannot start local OpenCV perception: ${error.message}`), { statusCode: 503 })));
    child.on("close", (code) => {
      if (code !== 0) return reject(Object.assign(new Error(`OpenCV perception failed: ${stderr.trim() || `exit ${code}`}`), { statusCode: 502 }));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(Object.assign(new Error("OpenCV perception returned invalid JSON"), { statusCode: 502 })); }
    });
    child.stdin.end(JSON.stringify({ imageData, previousState: previousState ?? null, previousImageData: previousImageData ?? null }));
  });
}

async function recommendGameAction({ game, objective, stateNotes, state, candidates }) {
  const jevState = { game, objective, player_context: stateNotes || "", observation: state, legal_actions: candidates };
  const questions = { action: {
    type: "choice",
    instructions: "Recommend one short next action for this game using the objective, player context, coarse ASCII color map, and detected motion regions. The map is lossy and does not identify objects. If the game state or button meaning is unclear, choose the WAIT candidate. Never invent controls or claim an action was executed.",
    criteria: Object.fromEntries(candidates.map(({ id, button, description }) => [id, `${button}: ${description}`])),
  } };
  const { response, data } = await callJev("systemone", { state: jevState, model: "jev-latest", questions });
  if (!response.ok) throw Object.assign(new Error(`Jev HTTP ${response.status}: ${data.message || data.error || "request failed"}`), { statusCode: response.status });
  const answer = data?.answers?.action;
  const candidate = candidates.find(({ id }) => id === answer?.choice);
  if (!candidate) throw Object.assign(new Error("Jev response did not select one of the supplied legal actions"), { statusCode: 502 });
  return { candidate, confidence: answer.confidence ?? null, probabilities: answer.probabilities ?? null, model: data.model ?? null };
}

let lastObsJevRequestAt = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(dashboard);
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true, service: "luffy-jev-gateway", jevConfigured: Boolean(apiKey), imagePerceptionConfigured: true, perception: "local-opencv-conservative", obsScreenshotConfigured: Boolean(process.env.OBS_SOURCE_NAME), obsAuthenticationConfigured: Boolean(process.env.OBS_WS_PASSWORD) });
  }
  if (req.method === "GET" && url.pathname === "/api/obs/screenshot") {
    try { return json(res, 200, await captureObsScreenshot()); }
    catch (error) { return json(res, error.statusCode || 502, { error: error.message }); }
  }
  if (req.method === "POST" && (url.pathname === "/api/game/decide" || url.pathname === "/api/fc26/decide")) {
    try {
      const body = await readJson(req);
      if (typeof body.imageData !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(body.imageData)) throw Object.assign(new Error("imageData must be a PNG, JPEG, or WebP data URL"), { statusCode: 400 });
      validateCandidates(body.candidates);
      const state = await analyzeFrame({ imageData: body.imageData, previousState: body.previousState, previousImageData: body.previousImageData });
      if (!Number.isFinite(state.confidence) || state.confidence < Number(process.env.MIN_VISION_CONFIDENCE || 0.55)) {
        return json(res, 200, { status: "abstain", reason: "visual_state_confidence_too_low", state, suggestedAction: null });
      }
      const recommendation = await recommendGameAction({ game: body.game || "Unspecified game", objective: body.objective || "Choose a safe next action", stateNotes: body.stateNotes, state, candidates: body.candidates });
      return json(res, 200, { status: "recommendation", state, suggestedAction: recommendation.candidate, confidence: recommendation.confidence, probabilities: recommendation.probabilities, model: recommendation.model, execution: "manual_only" });
    } catch (error) {
      return json(res, error.statusCode || (error.name === "TypeError" ? 502 : 400), { error: error.message || "request_failed" });
    }
  }
  if (req.method === "POST" && ["/api/game/obs-decide", "/api/fc26/obs-decide"].includes(url.pathname)) {
    try {
      const body = await readJson(req);
      validateCandidates(body.candidates);
      const frame = await captureObsScreenshot();
      const state = await analyzeFrame({ imageData: frame.imageData, previousState: body.previousState, previousImageData: body.previousImageData });
      if (!Number.isFinite(state.confidence) || state.confidence < Number(process.env.MIN_VISION_CONFIDENCE || 0.55)) {
        return json(res, 200, { status: "abstain", reason: "visual_state_confidence_too_low", sourceName: frame.sourceName, capturedAt: frame.capturedAt, imageData: frame.imageData, state, suggestedAction: null, execution: "manual_only" });
      }
      const jevInterval = Math.max(1000, Number(process.env.JEV_MIN_INTERVAL_MS || 2500));
      if (Date.now() - lastObsJevRequestAt < jevInterval) {
        return json(res, 200, { status: "pending", reason: "jev_request_cooldown", sourceName: frame.sourceName, capturedAt: frame.capturedAt, imageData: frame.imageData, state, suggestedAction: null, execution: "manual_only" });
      }
      lastObsJevRequestAt = Date.now();
      const recommendation = await recommendGameAction({ game: body.game || "Unspecified game", objective: body.objective || "Choose a safe next action", stateNotes: body.stateNotes, state, candidates: body.candidates });
      return json(res, 200, { status: "recommendation", sourceName: frame.sourceName, capturedAt: frame.capturedAt, imageData: frame.imageData, state, suggestedAction: recommendation.candidate, confidence: recommendation.confidence, probabilities: recommendation.probabilities, model: recommendation.model, execution: "manual_only" });
    } catch (error) {
      return json(res, error.statusCode || (error.name === "TypeError" ? 502 : 400), { error: error.message || "request_failed" });
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
