import { defineConfig } from "vite";
import { interpretQuestion, InterpretError } from "./server/interpret.js";

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new InterpretError("Request body is too large.", 413);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new InterpretError("Request body must be valid JSON.", 400);
  }
}

async function interpretMiddleware(request, response, next) {
  const pathname = new URL(
    request.url || "/",
    "http://127.0.0.1",
  ).pathname;
  if (pathname !== "/api/interpret") {
    next();
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, {
      ok: false,
      error: "Use POST for /api/interpret.",
    });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const result = await interpretQuestion(body.question);
    console.info(
      `[interpret] ${result.meta.cached ? "cache" : result.meta.model} · ${result.meta.elapsedMs}ms`,
    );
    sendJson(response, 200, result);
  } catch (error) {
    const status = error instanceof InterpretError ? error.status : 500;
    console.error(`[interpret] ${status} ${error.message}`);
    sendJson(response, status, {
      ok: false,
      error:
        error instanceof InterpretError
          ? error.message
          : "The interpreter hit an unexpected error. Manual input is still available.",
    });
  }
}

function interpreterPlugin() {
  return {
    name: "opencode-go-interpreter",
    configureServer(server) {
      server.middlewares.use(interpretMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(interpretMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [interpreterPlugin()],
  server: {
    host: "127.0.0.1",
  },
});
