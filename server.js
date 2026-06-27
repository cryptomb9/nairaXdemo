"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!process.env[key]) process.env[key] = rawValue.trim();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body || "");
}

const lastFunctionWarningAt = new Map();

function isExpectedNetworkError(error) {
  const message = String(error?.message || "");
  const causeCode = String(error?.cause?.code || "");
  return /fetch failed|connect timeout|network/i.test(message) || /UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(causeCode);
}

function logFunctionError(functionName, error) {
  const now = Date.now();
  const key = `${functionName}:${error?.message || "error"}`;
  const last = lastFunctionWarningAt.get(key) || 0;
  if (now - last < 15000) return;
  lastFunctionWarningAt.set(key, now);

  if (isExpectedNetworkError(error)) {
    console.warn(`[${functionName}] Network timeout while reaching Supabase/RPC. Check internet/VPN/Supabase project status.`);
    return;
  }
  console.error(`[${functionName}]`, error);
}

async function handleFunction(req, res, functionName) {
  const functionPath = path.join(ROOT, "netlify", "functions", `${functionName}.js`);
  if (!fs.existsSync(functionPath)) {
    send(res, 404, { "Content-Type": "application/json" }, JSON.stringify({ error: "Function not found" }));
    return;
  }

  try {
    const mod = require(functionPath);
    const body = await readBody(req);
    const result = await mod.handler({
      httpMethod: req.method,
      path: req.url,
      headers: req.headers,
      body,
      rawUrl: pathToFileURL(req.url).href,
    });

    send(res, result.statusCode || 200, result.headers || {}, result.body || "");
  } catch (error) {
    logFunctionError(functionName, error);
    send(res, 503, { "Content-Type": "application/json" }, JSON.stringify({
      error: isExpectedNetworkError(error)
        ? "Supabase/RPC network timeout. Check internet connection and try again."
        : (error.message || "Function failed"),
    }));
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === "/") filePath = "/index.html";

  const resolved = path.resolve(ROOT, `.${filePath}`);
  if (!resolved.startsWith(ROOT)) {
    send(res, 403, { "Content-Type": "text/plain" }, "Forbidden");
    return;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    send(res, 404, { "Content-Type": "text/plain" }, "Not found");
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  send(res, 200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" }, fs.readFileSync(resolved));
}

loadEnv();

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/.netlify/functions/")) {
      const functionName = req.url.split("/")[3]?.split("?")[0];
      await handleFunction(req, res, functionName);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    logFunctionError("server", error);
    send(res, 500, { "Content-Type": "application/json" }, JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, () => {
  console.log(`NairaX running at http://localhost:${PORT}`);
});
