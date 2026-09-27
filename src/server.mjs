import { createServer } from "node:http";

const port = Number(process.env.PORT || 8787);
const baseUrl = (process.env.JEV_BASE_URL || "https://www.jevai.org").replace(/\/$/, "");
const apiKey = (process.env.JEV_API_KEY || "").trim();
const maxBodyBytes = 32 * 1024;

const workflows = new Set([
  "decisions",
  "decisions/tool-guard",
  "decisions/model-route",
  "decisions/route",
  "decisions/research",
  "decisions/completion",
]);

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
  if (!apiKey) throw Object.assign(new Error("JEV_API_KEY is not configured"), { statusCode: 503 });
  const response = await fetch(`${baseUrl}/api/v1/${path}`, {
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true, service: "luffy-jev-gateway", jevConfigured: Boolean(apiKey) });
  }
  if (req.method !== "POST" || !url.pathname.startsWith("/api/jev/")) {
    return json(res, 404, { error: "not_found" });
  }

  const path = url.pathname.slice("/api/jev/".length);
  if (!workflows.has(path)) return json(res, 404, { error: "unsupported_workflow", workflows: [...workflows] });

  try {
    const body = await readJson(req);
    const { response, data } = await callJev(path, body);
    return json(res, response.status, data);
  } catch (error) {
    const status = error.statusCode || (error.name === "TypeError" ? 502 : 400);
    return json(res, status, { error: error.message || "request_failed" });
  }
});

server.listen(port, () => {
  console.log(`luffy Jev gateway listening on http://localhost:${port}`);
});
