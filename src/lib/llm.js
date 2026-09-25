import Groq from 'groq-sdk';
import { env, config } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('llm');

/**
 * The only place in the codebase that talks to a model. Swapping Groq for
 * OpenRouter / Ollama / anything OpenAI-compatible means editing this file
 * only — every agent calls `chat()` and never imports a vendor SDK.
 */
export const callLog = { totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 };

let client;
function getClient() {
  if (!env.groqApiKey) {
    throw new Error(
      'GROQ_API_KEY is missing. Copy .env.example to .env and add your key from https://console.groq.com/keys'
    );
  }
  client ??= new Groq({ apiKey: env.groqApiKey });
  return client;
}

/**
 * @param {object} options
 * @param {string} options.model
 * @param {Array<{role:string,content:string}>} options.messages
 * @param {number} [options.maxTokens] Hard cap. Reels are short — this is the main token lever.
 * @param {number} [options.temperature]
 * @param {boolean} [options.json] Request a JSON object response.
 * @param {string} [options.label] For logs.
 * @returns {Promise<{content:string, raw:object}>}
 */
export async function chat({ model, messages, maxTokens = 400, temperature = 0.7, json = false, label = 'call' }) {
  const started = Date.now();
  let response = await request(model, messages, maxTokens, temperature, json);

  // Some models (notably the gpt-oss reasoning family) reject a JSON response
  // format on non-trivial prompts with `json_validate_failed`. Our prompts
  // already demand JSON and parseJsonLoose handles fences, so degrade to
  // prompt-only rather than failing the whole run.
  if (!response.ok && response.errorCode === 'json_validate_failed') {
    log.warn(`${label}: model rejected JSON mode, retrying with prompt-only JSON`, { model });
    response = await request(model, messages, maxTokens, temperature, false);
  }

  if (!response.ok) {
    throw new Error(`${label} failed (${response.status} ${response.errorCode || ''}): ${response.errorMessage}`);
  }

  const { content, choice, usage } = response;
  if (choice.finish_reason === 'length') {
    throw new Error(
      `${label}: output hit the ${maxTokens}-token cap before finishing. ` +
      `Raise ${label === 'rank' ? 'llm.rankerMaxTokens' : 'llm.writerMaxTokens'} in config.json, ` +
      `or use a non-reasoning model — reasoning models spend most of the budget thinking.`
    );
  }

  callLog.totalCalls += 1;
  callLog.totalPromptTokens += usage.prompt_tokens || 0;
  callLog.totalCompletionTokens += usage.completion_tokens || 0;

  log.info(`${label} → ${model}`, {
    ms: Date.now() - started,
    in: usage.prompt_tokens || 0,
    out: usage.completion_tokens || 0
  });

  if (!content) throw new Error(`Empty response from ${model} for ${label}`);
  return { content, raw: response.raw };
}

async function request(model, messages, maxTokens, temperature, json) {
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (json) body.response_format = { type: 'json_object' };

  const res = await getClient().chat.completions.create(body).catch((err) => ({
    __transportError: err
  }));

  if (res.__transportError) {
    const msg = res.__transportError?.message || String(res.__transportError);
    if (res.__transportError?.status === 400 && msg.includes('json_validate_failed')) {
      return { ok: false, status: 400, errorCode: 'json_validate_failed', errorMessage: msg };
    }
    throw res.__transportError;
  }

  const choice = res.choices?.[0] || {};
  return {
    ok: true,
    status: 200,
    content: (choice.message?.content || '').trim(),
    choice,
    usage: res.usage || {},
    raw: res
  };
}

/**
 * Models occasionally wrap JSON in prose or fences. This pulls out the first
 * balanced object so a cosmetic formatting quirk can't kill the pipeline.
 */
export function parseJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error(`Could not parse JSON from model output: ${text.slice(0, 240)}`);
  }
}

export const models = {
  ranker: config.llm.rankerModel,
  writer: config.llm.writerModel
};
