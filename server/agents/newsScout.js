import Parser from 'rss-parser';
import { config, env } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { isAlreadyCovered, normalizeTitle } from '../lib/state.js';

const log = createLogger('newsScout');
const parser = new Parser();

/**
 * AGENT 1 — News Scout.  Zero LLM calls.
 *
 * Pulls candidate marine-industry headlines from keyless feeds, collapses
 * duplicates across sources, drops anything already covered, and returns a
 * short list of titles + one-line snippets for the ranker. Snippets only:
 * shipping full article bodies would multiply prompt tokens for no benefit.
 */
export async function newsScout() {
  const { googleNewsQueries, gdeltEnabled, gdeltQuery, lookbackDays, maxCandidates, minTitleLength } = config.news;
  const since = new Date(Date.now() - lookbackDays * 86400000);

  const sources = [
    ...googleNewsQueries.map((q, i) => ({ name: `Google News #${i + 1}`, kind: 'gnews', query: q })),
    ...(gdeltEnabled ? [{ name: 'GDELT', kind: 'gdelt', query: gdeltQuery }] : [])
  ];

  const settled = await Promise.allSettled(sources.map(fetchSource));
  const failures = [];

  const raw = settled.flatMap((r, i) => {
    if (r.status === 'rejected') {
      failures.push(`${sources[i].name}: ${r.reason?.message}`);
      return [];
    }
    return r.value;
  });

  if (!raw.length) {
    throw new Error(
      `All ${sources.length} news sources returned nothing. ${failures.join('; ')}`
    );
  }

  // A source failing while others succeed is a degraded run, not a broken one.
  // GDELT rate-limits aggressively (HTTP 429) and Google News covers the same
  // ground, so warning on every run trained the log to be ignored.
  if (failures.length) {
    log.info(`${failures.length}/${sources.length} sources unavailable`, {
      detail: failures.join('; ')
    });
  }

  const candidates = dedupe(raw)
    .filter((c) => c.title.length >= minTitleLength)
    .filter((c) => new Date(c.publishedAt) >= since || Number.isNaN(new Date(c.publishedAt).getTime()))
    .filter((c) => !isAlreadyCovered(c.title))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, maxCandidates);

  log.ok(`${raw.length} fetched → ${candidates.length} candidates after dedupe + covered-filter`);
  return candidates;
}

async function fetchSource(source) {
  const url =
    source.kind === 'gnews'
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(source.query)}&hl=en-US&gl=US&ceid=US:en`
      : `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(source.query)}&mode=ArtList&format=json&maxrecords=60&timespan=${config.news.lookbackDays * 24}h&sort=DateDesc`;

  // Fetch once and hand the body to the parser. Calling fetch() here and then
  // parser.parseURL(url) issued a second identical request per query, which
  // doubled the calls Google sees and made the 429s in the log more likely.
  const res = await fetch(url, {
    headers: { 'user-agent': 'swift-check-ai/1.0 (+marine reel bot)' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  if (source.kind === 'gnews') {
    const feed = await parser.parseString(await res.text());
    return feed.items.map((i) => ({
      title: cleanTitle(i.title || ''),
      snippet: (i.contentSnippet || i.summary || '').replace(/\s+/g, ' ').trim(),
      source: i.creator || googleSourceName(i.title) || 'Google News',
      url: i.link || '',
      publishedAt: i.isoDate || i.pubDate || new Date().toISOString()
    }));
  }

  const data = await res.json();
  return (data.articles || []).map((a) => ({
    title: (a.title || '').trim(),
    snippet: '',
    source: a.domain || 'GDELT',
    url: a.url || '',
    publishedAt: a.seendate ? isoFromGdelt(a.seendate) : new Date().toISOString()
  }));
}

/** Google News appends " - Publisher Name" to every headline. */
function googleSourceName(title = '') {
  const parts = title.split(' - ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : '';
}

function cleanTitle(title) {
  return title.split(' - ').slice(0, -1).join(' - ').trim() || title.trim();
}

function isoFromGdelt(seendate) {
  // GDELT uses YYYYMMDDTHHMMSSZ
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(seendate);
  if (!m) return new Date().toISOString();
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

/** Keeps the longest snippet for a normalized title seen across multiple sources. */
function dedupe(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = normalizeTitle(item.title);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, title: item.title.trim() });
    } else if ((item.snippet?.length || 0) > (existing.snippet?.length || 0)) {
      existing.snippet = item.snippet;
      existing.source = item.source;
      existing.url = item.url;
    }
  }
  return [...byKey.values()];
}

export { dedupe, cleanTitle };
