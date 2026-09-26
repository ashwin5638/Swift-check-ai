import Groq from 'groq-sdk';
import { env, config } from '../server/config.js';

/**
 * Verifies every model referenced in config.json is still served by Groq.
 *
 * Worth keeping: Groq retired llama-3.1-8b-instant and llama-3.3-70b-versatile
 * on 2026-08-16 with no runtime error until the call is made. This turns a
 * failed pipeline into a one-line warning.
 */
const MODELS = {
  'llm.rankerModel': config.llm.rankerModel,
  'llm.writerModel': config.llm.writerModel
};

if (!env.groqApiKey) {
  console.error('GROQ_API_KEY is not set (check .env).');
  process.exit(1);
}

const groq = new Groq({ apiKey: env.groqApiKey });
const { data } = await groq.models.list();
const available = new Set(data.map((m) => m.id));

console.log(`Groq is serving ${available.size} models.\n`);

let missing = 0;
for (const [key, model] of Object.entries(MODELS)) {
  const ok = available.has(model);
  if (!ok) missing += 1;
  console.log(`  ${ok ? 'OK     ' : 'MISSING'}  ${key} = ${model}`);
}

if (missing) {
  console.error(`\n${missing} configured model(s) unavailable.`);
  console.error('Fix: https://console.groq.com/docs/models  (edit config.json)');
  process.exit(1);
}

console.log('\nAll configured models are available.');
