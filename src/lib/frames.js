import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('frames');

/**
 * Renders the branded HTML template to one transparent PNG per on-screen beat.
 *
 * Playwright does the layout because CSS beats hand-rolled PIL/canvas drawing
 * for text wrapping, and the same file can be opened in a browser to tweak the
 * brand without touching JS. PNG overlays are then composited by FFmpeg using
 * time-based `enable` expressions — no per-frame JS looping.
 */
export async function renderBeatFrames({ beats, headline, source, workDir, durationSeconds, width, height }) {
  await fs.mkdir(workDir, { recursive: true });

  const template = await fs.readFile(path.join(config.paths.templates, 'frame.html'), 'utf8');
  const logoDataUri = await loadLogoDataUri();
  const timings = planBeats(beats.length, durationSeconds);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });

  const frames = [];
  try {
    for (const [i, timing] of timings.entries()) {
      const html = fillTemplate(template, {
        PRIMARY: config.brand.primaryColor,
        ACCENT: config.brand.accentColor,
        TEXT: config.brand.textColor,
        HANDLE: config.brand.handle,
        LOGO_DATA_URI: logoDataUri,
        HEADLINE: escapeHtml(headline.toUpperCase()),
        BEAT: escapeHtml(beats[i].toUpperCase()),
        SOURCE: escapeHtml(source || 'industry desk'),
        PROGRESS: Math.round(((i + 1) / timings.length) * 100)
      });

      await page.setContent(html, { waitUntil: 'load' });
      // Webfonts come from a CDN; without this the first frame can render in a fallback face.
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(120);

      const file = path.join(workDir, `beat-${String(i + 1).padStart(2, '0')}.png`);
      await page.screenshot({ path: file, omitBackground: true });
      frames.push({ ...timing, file, index: i });
      log.debug(`Rendered beat ${i + 1}/${timings.length}`);
    }
  } finally {
    await browser.close();
  }

  log.ok(`Rendered ${frames.length} beat frames`);
  return frames;
}

/**
 * Beat timing is deterministic: the intro beat gets a shorter slot so the
 * hook lands fast, the takeaway gets the longest. No LLM arithmetic involved.
 */
export function planBeats(count, durationSeconds) {
  const weights = count === 3 ? [0.26, 0.36, 0.38] : count === 4 ? [0.22, 0.28, 0.25, 0.25] : null;
  const w = weights ?? Array.from({ length: count }, () => 1 / count);

  let cursor = 0;
  return w.map((weight, i) => {
    const start = Number(cursor.toFixed(3));
    const end = i === w.length - 1 ? Number(durationSeconds.toFixed(3)) : Number((start + weight * durationSeconds).toFixed(3));
    cursor = end;
    return { start, end, duration: Number((end - start).toFixed(3)) };
  });
}

async function loadLogoDataUri() {
  const logoPath = path.join(config.paths.root, config.brand.logo);
  try {
    const buf = await fs.readFile(logoPath);
    return `data:image/svg+xml;base64,${buf.toString('base64')}`;
  } catch {
    log.warn('logo.svg not found — rendering without the brand mark.');
    return '';
  }
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
