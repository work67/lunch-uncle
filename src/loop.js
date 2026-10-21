import { SYSTEM_PROMPT, describeSingaporeTime } from "./prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";

const LLM_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_ROUNDS = 6;
// Caps tool fetches per turn. With MAX_ROUNDS model calls plus a final answer
// call, a turn stays well under the Workers free plan's 50 subrequests.
const MAX_TOOL_CALLS = 12;

// History the client sends is trimmed to this before every turn.
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 2000;

const EMPTY_REPLY = "Uncle blur already. Ask me again.";

/**
 * Run the agentic loop for one user turn and return Uncle's reply.
 *
 * history is the prior conversation as OpenAI-style {role, content} messages,
 * already passed through sanitizeHistory. sessionId is stable for the whole
 * conversation, so the OpenCode Go endpoint can route and cache consistently.
 */
export async function runLoop(history, message, env, sessionId) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    {
      role: "user",
      content: `${message}\n\n(${describeSingaporeTime(new Date())})`,
    },
  ];

  // Identical calls within a turn reuse the first result.
  const results = new Map();
  let toolCallsMade = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const assistant = await callModel(messages, env, sessionId);
    const toolCalls = Array.isArray(assistant.tool_calls)
      ? assistant.tool_calls
      : [];
    if (toolCalls.length === 0) {
      return replyText(assistant);
    }

    // Only keep what the next call needs, not reasoning_content.
    messages.push({
      role: "assistant",
      content: assistant.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      const key = `${name}:${JSON.stringify(args)}`;

      let result = results.get(key);
      if (result === undefined && toolCallsMade >= MAX_TOOL_CALLS) {
        result = JSON.stringify({
          error: "No more lookups this turn. Answer with what you have.",
        });
      } else if (result === undefined) {
        toolCallsMade++;
        console.log(`round ${round}: ${name}`, args);
        result = await executeTool(name, args, env);
        results.set(key, result);
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // Out of rounds: ask for an answer from the tool results gathered so far.
  const final = await callModel(messages, env, sessionId, { allowTools: false });
  return replyText(final);
}

async function callModel(messages, env, sessionId, { allowTools = true } = {}) {
  // The OpenAI-compatible endpoint and model come from env (LLM_BASE_URL, LLM_MODEL).
  if (!env.LLM_BASE_URL || !env.LLM_MODEL || !env.OPENCODE_API_KEY) {
    throw new Error(
      "LLM_BASE_URL, LLM_MODEL and OPENCODE_API_KEY must be set in env",
    );
  }

  const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      messages,
      tools: toolDefinitions,
      tool_choice: allowTools ? "auto" : "none",
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`LLM returned ${res.status}: ${detail}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("LLM returned a response that is not JSON");
  }
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    throw new Error(
      `LLM response has no message: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }
  return message;
}

function replyText(assistant) {
  const text =
    typeof assistant.content === "string" ? assistant.content.trim() : "";
  return text || EMPTY_REPLY;
}

/**
 * Parse tool-call arguments, which providers send as a JSON string or an object.
 * Anything that is not a plain object becomes {}.
 */
export function parseArgs(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * Keep only recent user and assistant text messages from client-sent history,
 * so a client cannot inject system or tool messages or send unbounded context.
 */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter(
      (m) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== "",
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content }) => ({
      role,
      content: content.slice(0, MAX_HISTORY_CHARS),
    }));
}
