import ui from "./ui.html";
import { runLoop, sanitizeHistory } from "./loop.js";

const MAX_BODY_CHARS = 32_000;
const MAX_MESSAGE_CHARS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(ui, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && pathname === "/chat") {
      return handleChat(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleChat(request, env) {
  // Only the chat page on this Worker may call /chat from a browser.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: "Forbidden" }, 403);
  }

  // Per-IP limit from the CHAT_LIMITER binding in wrangler.toml.
  if (env.CHAT_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.CHAT_LIMITER.limit({ key: ip });
    if (!success) {
      return json({ error: "Uncle busy. Wait a minute, then ask again." }, 429);
    }
  }

  if (Number(request.headers.get("content-length")) > MAX_BODY_CHARS) {
    return json({ error: "Request too large" }, 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return json({ error: "Request too large" }, 413);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object" }, 400);
  }

  const { history, message, session_id } = body;
  if (typeof message !== "string" || message.trim() === "") {
    return json({ error: "message is required" }, 400);
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return json({ error: "message is too long" }, 400);
  }
  const sessionId =
    typeof session_id === "string" && UUID.test(session_id)
      ? session_id
      : crypto.randomUUID();

  try {
    const reply = await runLoop(
      sanitizeHistory(history),
      message.trim(),
      env,
      sessionId,
    );
    return json({ reply });
  } catch (err) {
    console.error("chat failed:", err);
    return json({ error: "Uncle cannot think right now, try again later." }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
