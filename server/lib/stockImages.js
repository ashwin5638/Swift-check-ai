import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('stockImages');

// Generic marine fallbacks keep the pipeline alive when Pexels has no Pexels-key
// or returns something off-topic for a niche story.
const FALLBACK_QUERIES = [
  'container ship',
  'cargo vessel ocean',
  'port crane shipping',
  'ocean waves aerial',
  'seawall harbor'
];

/**
 * Fetches one landscape photo from Pexels and returns a local file path.
 * The image is intentionally left oversized — FFmpeg crops and zooms it.
 */
export async function fetchBackgroundImage(query, workDir) {
  await fs.mkdir(workDir, { recursive: true });

  if (!env.pexelsApiKey) {
    log.warn('PEXELS_API_KEY missing — falling back to a generated gradient background.');
    return { file: null, query, source: 'ffmpeg-gradient', photographer: null };
  }

  const attempts = [query, ...FALLBACK_QUERIES];
  for (const [i, q] of attempts.entries()) {
    try {
      const photo = await searchPexels(q, 1).then((r) => r[0]);
      if (!photo) continue;
      const file = path.join(workDir, 'background.jpg');
      await download(photo.src.original ?? photo.src.large2x, file);
      log.ok(`Pexels image: "${q}"`, { photographer: photo.photographer, source: photo.source });
      return {
        file,
        query: q,
        source: 'pexels',
        photographer: photo.photographer,
        sourcePage: photo.url
      };
    } catch (err) {
      log.warn(`Pexels lookup failed for "${q}"`, { reason: err.message, attempt: i + 1 });
    }
  }

  log.warn('All Pexels lookups failed — using generated gradient background.');
  return { file: null, query, source: 'ffmpeg-gradient', photographer: null };
}

async function searchPexels(query, perPage) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=landscape&size=large&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Authorization: env.pexelsApiKey }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const data = await res.json();
  return (data.photos || []).map((p) => ({
    src: p.src,
    photographer: p.photographer,
    url: p.url,
    source: 'pexels'
  }));
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`image download HTTP ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}
