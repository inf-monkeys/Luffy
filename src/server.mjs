import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const baseUrl = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
const apiKey = (process.env.TYPESAFE_API_KEY || "").trim();
const visionBaseUrl = (process.env.VISION_API_BASE_URL || "").replace(/\/$/, "");
const visionApiKey = (process.env.VISION_API_KEY || "").trim();
const visionModel = process.env.VISION_MODEL || "";
const maxBodyBytes = 6 * 1024 * 1024;

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
    if (size > maxBodyBytes) throw new Error("request body exceeds 32 KiB");
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

async function analyzeFrame({ imageData, previousState }) {
  if (!visionBaseUrl || !visionApiKey || !visionModel) {
    throw Object.assign(new Error("Configure VISION_API_BASE_URL, VISION_API_KEY, and VISION_MODEL to enable image perception"), { statusCode: 503 });
  }
  const prompt = `Analyze this single EA SPORTS FC 26 Nintendo Switch gameplay frame. Return only JSON with: {"phase":"menu|kickoff|open_play|set_piece|replay|pause|unknown","scoreboard":{"home":number|null,"away":number|null,"clock":"string|null"},"ball":{"x":number|null,"y":number|null,"confidence":number},"controlled_player":{"x":number|null,"y":number|null,"confidence":number},"visible_players":[{"team":"ours|opponents|unknown","x":number,"y":number,"confidence":number}],"possession":"ours|opponents|loose|unknown","attack_direction":"left|right|unknown","on_screen_hints":["..."],"confidence":number,"uncertainty":["..."]}. Coordinates must be normalized 0..1 within the pitch/play area, not the whole TV frame. Do not guess entities hidden or too small to identify; use null/unknown and lower confidence. Do not recommend a button. Previous observation for temporal continuity: ${JSON.stringify(previousState ?? null)}`;
  const response = await fetch(`${visionBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${visionApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: visionModel, temperature: 0, response_format: { type: "json_object" }, messages: [
      { role: "system", content: "You are a conservative visual state extractor for a video game. Return only valid JSON matching the requested schema. Never infer hidden game state." },
      { role: "user", content: [ { type: "text", text: prompt }, { type: "image_url", image_url: { url: imageData } } ] },
    ] }),
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { error: raw }; }
  if (!response.ok) throw Object.assign(new Error(`vision provider HTTP ${response.status}: ${payload.error?.message || payload.message || "request failed"}`), { statusCode: 502 });
  try { return JSON.parse(payload.choices[0].message.content); }
  catch { throw Object.assign(new Error("vision provider returned invalid JSON state"), { statusCode: 502 }); }
}

async function recommendFc26({ state, candidates }) {
  const jevState = { game: "EA SPORTS FC 26 on Nintendo Switch", observation: state, legal_actions: candidates };
  const questions = { action: {
    type: "choice",
    instructions: "Given only the visible observation and legal button candidates, which single controller action is the best next short action? Choose WAIT if information is insufficient. Do not invent button combinations.",
    criteria: Object.fromEntries(candidates.map(({ id, button, description }) => [id, `${button}: ${description}`])),
  } };
  const { response, data } = await callJev("systemone", { state: jevState, model: "jev-latest", questions });
  if (!response.ok) throw Object.assign(new Error(`Jev HTTP ${response.status}: ${data.message || data.error || "request failed"}`), { statusCode: response.status });
  const answer = data?.answers?.action;
  const candidate = candidates.find(({ id }) => id === answer?.choice);
  if (!candidate) throw Object.assign(new Error("Jev response did not select one of the supplied legal actions"), { statusCode: 502 });
  return { candidate, confidence: answer.confidence ?? null, probabilities: answer.probabilities ?? null, model: data.model ?? null };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true, service: "luffy-jev-gateway", jevConfigured: Boolean(apiKey), imagePerceptionConfigured: Boolean(visionBaseUrl && visionApiKey && visionModel), obsScreenshotConfigured: Boolean(process.env.OBS_SOURCE_NAME) });
  }
  if (req.method === "GET" && url.pathname === "/api/obs/screenshot") {
    try { return json(res, 200, await captureObsScreenshot()); }
    catch (error) { return json(res, error.statusCode || 502, { error: error.message }); }
  }
  if (req.method === "POST" && url.pathname === "/api/fc26/decide") {
    try {
      const body = await readJson(req);
      if (typeof body.imageData !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(body.imageData)) throw Object.assign(new Error("imageData must be a PNG, JPEG, or WebP data URL"), { statusCode: 400 });
      validateCandidates(body.candidates);
      const state = await analyzeFrame({ imageData: body.imageData, previousState: body.previousState });
      if (!Number.isFinite(state.confidence) || state.confidence < Number(process.env.MIN_VISION_CONFIDENCE || 0.55)) {
        return json(res, 200, { status: "abstain", reason: "visual_state_confidence_too_low", state, suggestedAction: null });
      }
      const recommendation = await recommendFc26({ state, candidates: body.candidates });
      return json(res, 200, { status: "recommendation", state, suggestedAction: recommendation.candidate, confidence: recommendation.confidence, probabilities: recommendation.probabilities, model: recommendation.model, execution: "manual_only" });
    } catch (error) {
      return json(res, error.statusCode || (error.name === "TypeError" ? 502 : 400), { error: error.message || "request_failed" });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/fc26/obs-decide") {
    try {
      const body = await readJson(req);
      validateCandidates(body.candidates);
      const frame = await captureObsScreenshot();
      const state = await analyzeFrame({ imageData: frame.imageData, previousState: body.previousState });
      if (!Number.isFinite(state.confidence) || state.confidence < Number(process.env.MIN_VISION_CONFIDENCE || 0.55)) {
        return json(res, 200, { status: "abstain", reason: "visual_state_confidence_too_low", sourceName: frame.sourceName, capturedAt: frame.capturedAt, state, suggestedAction: null, execution: "manual_only" });
      }
      const recommendation = await recommendFc26({ state, candidates: body.candidates });
      return json(res, 200, { status: "recommendation", sourceName: frame.sourceName, capturedAt: frame.capturedAt, state, suggestedAction: recommendation.candidate, confidence: recommendation.confidence, probabilities: recommendation.probabilities, model: recommendation.model, execution: "manual_only" });
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
