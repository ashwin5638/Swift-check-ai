import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { fetchBackgroundImage } from '../lib/stockImages.js';
import { renderBeatFrames } from '../lib/frames.js';
import { synthesizeVoiceover, buildMusicBed } from '../lib/audio.js';
import { runFfmpeg, probeDuration } from '../lib/ffmpeg.js';

const log = createLogger('visualBuilder');

/**
 * AGENT 4 — Visual Builder.  Zero LLM calls.
 *
 * Pexels photo → Playwright renders the branded beat overlays → FFmpeg applies
 * Ken Burns zoom, composites the overlays on time windows, and muxes the
 * edge-tts voiceover under a music bed. Fully deterministic and free.
 */
export async function visualBuilder({ script, event, runId }) {
  const { width, height, fps, durationSeconds, kenBurnsZoom } = config.reel;
  const workDir = path.join(config.paths.output, runId, 'work');
  const outputFile = path.join(config.paths.output, `${runId}.mp4`);
  await fs.mkdir(workDir, { recursive: true });

  // 1. Voiceover first — its length decides the final timeline, which the beat
  //    overlays have to be timed against.
  const voiceFile = await synthesizeVoiceover(script.voiceover, workDir);
  const finalDuration = voiceFile ? await fitDuration(voiceFile, durationSeconds) : durationSeconds;

  // 2. Background photo
  const background = await fetchBackgroundImage(script.imageQuery, workDir);

  // 3. Branded overlays, timed against the final duration
  const frames = await renderBeatFrames({
    beats: script.beats,
    headline: script.headline,
    source: script.sourceName || background.photographer,
    workDir,
    durationSeconds: finalDuration,
    width,
    height
  });

  // 4. Music bed
  const music = await buildMusicBed(workDir, finalDuration);

  // 5. Assemble
  const args = await buildFfmpegArgs({
    background, frames, voiceFile, music,
    width, height, fps, durationSeconds: finalDuration, kenBurnsZoom,
    outputFile
  });

  await runFfmpeg(args, { label: 'assemble' });

  const stat = await fs.stat(outputFile);
  log.ok(`Reel rendered → ${path.basename(outputFile)} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

  return {
    videoPath: outputFile,
    videoUrl: `/media/${runId}.mp4`,
    thumbnailPath: path.join(config.paths.output, `${runId}.jpg`),
    durationSeconds: (await probeDuration(outputFile)) ?? finalDuration,
    sizeBytes: stat.size,
    image: background,
    beatFrames: frames.map((f) => ({ start: f.start, end: f.end, text: script.beats[f.index] })),
    hasVoiceover: Boolean(voiceFile),
    hasMusic: Boolean(music)
  };
}

/**
 * Builds one flat ffmpeg command.
 *
 * Order matters: every `-i` must precede the filtergraph and all output options.
 * Building video and audio args separately and concatenating puts `-t` before the
 * audio inputs, which ffmpeg rejects. So inputs are collected first, then one
 * combined filtergraph, then outputs.
 */
async function buildFfmpegArgs({ background, frames, voiceFile, music, width, height, fps, durationSeconds, kenBurnsZoom, outputFile }) {
  const inputArgs = [];

  // Input 0 — the Ken Burns base layer.
  if (background.file) {
    inputArgs.push('-loop', '1', '-i', background.file);
  } else {
    // No usable photo: synthesise a branded gradient plate instead. Generated at
    // output resolution and scaled up by the filtergraph — a gradient has no
    // detail to lose, and asking the `gradients` source for 2160x3840 is slow.
    inputArgs.push('-f', 'lavfi', '-i',
      `gradients=s=${width}x${height}:c0=0x041E2E:c1=0x0A3A50:c2=0x01121C:n=3:duration=${durationSeconds}:speed=0.02`);
    log.warn('Using FFmpeg gradient background (no photo available)');
  }

  // Inputs 1..N — the transparent beat overlays.
  for (const frame of frames) inputArgs.push('-i', frame.file);

  // Inputs N+1, N+2 — audio. Tracked by explicit index because the
  // filtergraph refers to streams by position.
  let voiceIndex = null;
  let musicIndex = null;
  if (voiceFile) {
    voiceIndex = 1 + frames.length;
    inputArgs.push('-i', voiceFile);
  }
  if (music) {
    musicIndex = 1 + frames.length + (voiceFile ? 1 : 0);
    inputArgs.push('-stream_loop', '-1', '-i', music.file);
  }

  const filters = [];
  const zoomSteps = Math.max(2, Math.round(durationSeconds * fps));
  filters.push(
    `[0:v]scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,` +
    `crop=${width * 2}:${height * 2},` +
    `zoompan=z='min(zoom+${((kenBurnsZoom - 1) / zoomSteps).toFixed(7)},${kenBurnsZoom})'` +
    `:d=${zoomSteps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps},` +
    `setsar=1,format=rgba[bg]`
  );

  let label = 'bg';
  frames.forEach((frame, i) => {
    const out = `ov${i + 1}`;
    filters.push(
      `[${label}][${i + 1}:v]overlay=0:0:format=auto:eof_action=pass:enable='between(t,${frame.start},${frame.end})'[${out}]`
    );
    label = out;
  });
  filters.push(`[${label}]format=yuv420p[outv]`);

  const outputArgs = ['-map', '[outv]', '-t', String(durationSeconds)];

  if (voiceFile || music) {
    if (voiceFile) {
      filters.push(`[${voiceIndex}:a]aresample=44100,apad,atrim=0:${durationSeconds},asetpts=N/SR/TB[vo]`);
    }
    if (musicIndex !== null) {
      filters.push(`[${musicIndex}:a]volume=${config.reel.musicVolume},aresample=44100,atrim=0:${durationSeconds},asetpts=N/SR/TB[bed]`);
    }
    filters.push(
      voiceFile && musicIndex !== null
        ? '[vo][bed]amix=inputs=2:duration=longest:normalize=0[outa]'
        : voiceFile ? '[vo]anull[outa]' : '[bed]anull[outa]'
    );
    outputArgs.push('-map', '[outa]');
  }

  return [
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    ...outputArgs,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart',
    outputFile
  ];
}

/**
 * Narration longer than the target means the reel grows; it never truncates, so
 * a wordy voiceover can never be cut off mid-sentence. Capped by
 * config.reel.maxDurationSeconds rather than a number inlined here, because the
 * target is a floor and the cap is the real ceiling on how long a reel can get.
 */
async function fitDuration(voiceFile, target) {
  const actual = await probeDuration(voiceFile);
  if (!actual) return target;
  const needed = Number((actual + 0.9).toFixed(2));
  const cap = config.reel.maxDurationSeconds ?? Infinity;
  const final = Math.min(Math.max(needed, target), cap);
  if (final !== target) {
    log.info(`Reel length adjusted ${target}s → ${final}s to fit the voiceover`);
  }
  return final;
}
