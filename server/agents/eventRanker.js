import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { chat, parseJsonLoose, models } from '../lib/llm.js';

const log = createLogger('eventRanker');

/**
 * AGENT 2 — Event Ranker.  Exactly 1 LLM call per day.
 *
 * Scoring and selecting are fused: rather than one call per candidate (10-15
 * calls), the model sees every headline at once and returns a single winner.
 * Titles + one-line snippets only, and max_tokens is capped low because the whole
 * answer is an index, a title, and a sentence.
 */
export async function eventRanker(candidates) {
  if (!candidates?.length) {
    throw new Error('eventRanker received no candidates — newsScout produced nothing usable.');
  }

  const list = candidates
    .map((c, i) => `${i + 1}. TITLE: ${c.title}\n   SOURCE: ${c.source}${c.snippet ? `\n   NOTE: ${truncate(c.snippet, 180)}` : ''}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content:
        'You are the news editor for "Swift Check AI", a brand covering the commercial shipping, ports and marine industry. ' +
        'You select ONE story per day. You value: real operational impact on shipowners, ports, marine insurers, offshore operators ' +
        'and regulators; hard numbers; regulatory or legal change; supply-chain disruption; safety incidents. ' +
        'You deprioritise: opinion pieces, marketing/PR announcements, routine quarterly earnings, sports, local weather, ' +
        'and duplicate coverage of the same underlying event. Reply with JSON only.'
    },
    {
      role: 'user',
      content:
        `Pick the single most significant marine-industry story from today's list. Ignore the numbering being out of order.\n\n${list}\n\n` +
        'Return exactly this JSON shape:\n' +
        '{"choice": <number>, "reason": "<one sentence, max 25 words, why this matters to the marine industry>"}'
    }
  ];

  const { content } = await chat({
    model: models.ranker,
    messages,
    maxTokens: config.llm.rankerMaxTokens,
    temperature: 0.2,
    json: true,
    label: 'rank'
  });

  const parsed = parseJsonLoose(content);
  const index = Number.parseInt(parsed.choice, 10);
  const chosen = candidates[index - 1];

  if (!chosen) {
    log.warn(`Ranker returned invalid choice "${parsed.choice}". Falling back to the most recent headline.`);
    const fallback = candidates[0];
    return { ...fallback, reason: parsed.reason || 'Fallback: most recent headline.', rankerUsedFallback: true };
  }

  log.ok(`Picked: "${chosen.title}"`, { reason: parsed.reason });
  return { ...chosen, reason: parsed.reason || '' };
}

function truncate(text, n) {
  return text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`;
}
