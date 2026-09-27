import { createServer } from "node:http";

const port = Number(process.env.PORT || 8787);
const baseUrl = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
const apiKey = (process.env.TYPESAFE_API_KEY || "").trim();
const maxBodyBytes = 32 * 1024;

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true, service: "luffy-jev-gateway", jevConfigured: Boolean(apiKey) });
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

server.listen(port, () => {
  console.log(`luffy Jev gateway listening on http://localhost:${port}`);
});
