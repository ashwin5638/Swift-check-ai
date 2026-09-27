import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { chat, parseJsonLoose, models } from '../lib/llm.js';

const log = createLogger('scriptWriter');

/**
 * AGENT 3 — Script Writer.  Exactly 1 LLM call per day.
 *
 * Voiceover, on-screen beats, both platform captions and hashtags all come out of
 * a single JSON response. Splitting them would triple the request overhead for
 * content that is 95% the same context.
 *
 * The model returns *text only* — no timestamps. Beat timing is computed
 * deterministically in visualBuilder, which is cheaper and more reliable than
 * asking a model to do arithmetic.
 */
export async function scriptWriter(event) {
  const messages = [
    {
      role: 'system',
      content:
        'You write scripts for "Swift Check AI" — short, high-retention vertical video about the commercial shipping and marine industry. ' +
        'Style: confident, factual, zero hype, no clickbait, no exclamation marks, no emoji in the voiceover. ' +
        'Never invent numbers, company names or quotes that are not in the source material. ' +
        'If the source lacks detail, keep the claim general rather than fabricating specifics. ' +
        'Reply with JSON only.'
    },
    {
      role: 'user',
      content: buildPrompt(event)
    }
  ];

  const { content } = await chat({
    model: models.writer,
    messages,
    maxTokens: config.llm.writerMaxTokens,
    temperature: config.llm.temperature,
    json: true,
    label: 'write'
  });

  const script = normalize(parseJsonLoose(content), event);
  log.ok('Script ready', { beats: script.beats.length, hashtags: script.hashtags.length });
  return script;
}

// Measured against this prompt's cadence at config.reel.voiceRate (+18%), which
// runs near 2.4 words/second. Deriving the range from durationSeconds is what
// stops the narration and the timeline drifting apart.
const WORDS_PER_SECOND = 2.4;

function buildPrompt(event) {
  const { durationSeconds } = config.reel;
  const words = Math.round(durationSeconds * WORDS_PER_SECOND);
  const minWords = Math.round(words * 0.85);
  const maxWords = Math.round(words * 1.15);
  return [
    `STORY TITLE: ${event.title}`,
    event.snippet ? `SOURCE NOTE: ${truncate(event.snippet, 400)}` : '',
    event.source ? `SOURCE: ${event.source}` : '',
    event.reason ? `WHY IT WAS PICKED: ${event.reason}` : '',
    '',
    `Write the content package for ONE ${durationSeconds}-second vertical reel.`,
    '',
    'Hard limits:',
    `- "voiceover": read aloud, must be ${minWords}-${maxWords} words so it fits ${durationSeconds}s at a brisk pace. One hook, one fact, one takeaway. Write numbers as spoken words.`,
    '- "beats": 4 or 5 on-screen text cards, in order. Each max 7 words, uppercase-friendly, no hashtags, no emoji. First beat is the hook.',
    '- "headline": max 5 words, the persistent top banner.',
    '- "facebookCaption": 1-2 short sentences plus a question to invite comments. Conversational.',
    '- "linkedinCaption": 2-3 sentences, professional, industry-specific, ends with a single takeaway line.',
    '- "hashtags": 5-7, each starting with #, no spaces. Mix broad (#shipping, #maritime) with specific.',
    '- "imageQuery": 3-6 words for a stock-photo search (e.g. "container ship port crane"). Must be visually literal and marine-related, no text or logos in the photo.',
    '',
    'Return exactly this JSON shape:',
    '{"headline":"","voiceover":"","beats":["","","",""],"facebookCaption":"","linkedinCaption":"","hashtags":["#"],"imageQuery":""}'
  ]
    .filter(Boolean)
    .join('\n');
}

/** Fills every field the visuals depend on so visualBuilder never sees undefined. */
function normalize(raw, event) {
  const MIN_BEATS = 4;
  const MAX_BEATS = 5;

  const beats = Array.isArray(raw.beats)
    ? raw.beats.map((b) => String(b).trim()).filter(Boolean).slice(0, MAX_BEATS)
    : [];

  if (beats.length < MIN_BEATS) {
    // Degrade to a working reel rather than failing the run.
    beats.push(...Array.from({ length: MIN_BEATS - beats.length }, () => shorten(event.title, 7)));
  }

  const hashtags = Array.isArray(raw.hashtags)
    ? raw.hashtags
        .map((h) => String(h).trim().replace(/\s+/g, ''))
        .filter((h) => h.startsWith('#') && h.length > 1)
        .slice(0, 7)
    : ['#shipping', '#maritime', '#marineindustry'];

  return {
    headline: shorten(raw.headline || shorten(event.title, 5), 5),
    voiceover: String(raw.voiceover || '').trim(),
    beats,
    facebookCaption: String(raw.facebookCaption || '').trim(),
    linkedinCaption: String(raw.linkedinCaption || '').trim(),
    hashtags,
    imageQuery: String(raw.imageQuery || 'container ship ocean port').trim(),
    sourceUrl: event.url || '',
    sourceName: event.source || ''
  };
}

function shorten(text, words) {
  return String(text || '').split(/\s+/).slice(0, words).join(' ');
}

function truncate(text, n) {
  return text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`;
}
