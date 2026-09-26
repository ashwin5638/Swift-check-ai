import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { createLogger } from './logger.js';

const log = createLogger('ffmpeg');

if (!ffmpegPath) {
  throw new Error('ffmpeg-static failed to provide a binary. Reinstall dependencies.');
}

/**
 * Thin wrapper over the ffmpeg binary. Args are passed straight through — no
 * fluent wrapper — so the filtergraphs below read exactly like ffmpeg docs.
 *
 * Warnings are captured but not echoed by default: swscaler pixel-format
 * deprecation notices alone produced ~250 lines of noise on a 15-second render.
 * They are still attached to the thrown error, so a real failure stays legible.
 */
export function runFfmpeg(args, { quiet = true, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', quiet ? 'error' : 'warning', '-y', ...args], {
      windowsHide: true
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!quiet) process.stderr.write(text);
      stderr += text;
    });

    proc.on('error', (err) => reject(new Error(`Failed to launch ffmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderr.trim().split('\n').slice(-12).join('\n');
      reject(new Error(`ffmpeg ${label} exited with code ${code}\n${tail}`));
    });
  });
}

/** Reads a media duration in seconds using ffmpeg's own probe output. */
export function probeDuration(file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('close', () => {
      const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
      if (!match) return resolve(null);
      resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
    proc.on('error', () => resolve(null));
  });
}

export function ffmpegBinaryPath() {
  log.debug(`ffmpeg: ${ffmpegPath}`);
  return ffmpegPath;
}
