import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('audio');

/**
 * Voiceover via Microsoft Edge's TTS endpoint (the same one Windows uses).
 * Free, unlimited, no API key, and — critically — zero LLM tokens.
 */
export async function synthesizeVoiceover(text, workDir) {
  await fs.mkdir(workDir, { recursive: true });

  if (!text?.trim()) {
    log.error('No voiceover text — the reel would be silent.', {
      hint: 'The script writer returned an empty voiceover.'
    });
    return null;
  }

  const file = path.join(workDir, 'voiceover.mp3');
  try {
    const { EdgeTTS } = await import('@andresaya/edge-tts');
    const tts = new EdgeTTS();
    await tts.synthesize(text, config.reel.voice, {
      pitch: config.reel.voicePitch,
      rate: config.reel.voiceRate
    });
    // toFile appends its own extension and returns the path it actually wrote,
    // so trust the return value rather than the requested filename.
    const written = await tts.toFile(path.join(workDir, 'voiceover'));
    log.ok(`Voiceover synthesised (${config.reel.voice})`);
    return written;
  } catch (err) {
    // A silent reel looks identical to a working one in the dashboard, so this
    // used to disappear into the log and a blank video got published as if it
    // were fine. Loud on purpose: the fix is to re-run, not to shrug.
    log.error('TTS failed — the reel will have no voiceover.', {
      reason: err.message,
      hint: 'edge-tts is a free Microsoft endpoint; this is usually a transient network fault. Re-run the pipeline.'
    });
    return null;
  }
}

/**
 * Background bed. If you drop a royalty-free track at
 * `server/assets/music/track.mp3` it is used as-is. Otherwise we synthesise a
 * soft ambient pad with FFmpeg's `sine` sources so the reel never ships silent
 * and the repo stays free of licensed audio binaries.
 */
export async function buildMusicBed(workDir, durationSeconds) {
  await fs.mkdir(workDir, { recursive: true });

  const trackPath = path.join(config.paths.assets, 'music', 'track.mp3');
  if (await exists(trackPath)) {
    log.ok('Using bundled music track');
    return { file: trackPath, generated: false };
  }

  if (!config.reel.includeMusic) return null;

  const file = path.join(workDir, 'music.m4a');
  const { runFfmpeg } = await import('./ffmpeg.js');
  try {
    // A minor 9th pad: root, fifth, octave, ninth. Low-passed + slow tremolo
    // keeps it under the voiceover.
    await runFfmpeg([
      '-f', 'lavfi',
      '-i', 'sine=frequency=110:duration=' + durationSeconds,
      '-f', 'lavfi',
      '-i', 'sine=frequency=164.81:duration=' + durationSeconds,
      '-f', 'lavfi',
      '-i', 'sine=frequency=220:duration=' + durationSeconds,
      '-f', 'lavfi',
      '-i', 'sine=frequency=246.94:duration=' + durationSeconds,
      '-filter_complex',
      '[0:a]volume=0.30[a0];[1:a]volume=0.18[a1];[2:a]volume=0.10[a2];[3:a]volume=0.07[a3];' +
        '[a0][a1][a2][a3]amix=inputs=4:normalize=0[mix];' +
        '[mix]lowpass=f=900,tremolo=f=0.25:d=0.35,afade=t=in:st=0:d=1.5,afade=t=out:st=' +
        Math.max(0, durationSeconds - 2) + ':d=2,volume=0.9[out]',
      '-map', '[out]',
      '-c:a', 'aac', '-b:a', '128k', file
    ], { quiet: true });
    log.ok('Generated ambient music bed');
    return { file, generated: true };
  } catch (err) {
    log.warn('Music generation failed — continuing without a bed.', { reason: err.message });
    return null;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
