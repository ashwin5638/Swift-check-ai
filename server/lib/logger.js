import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const COLOR = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  step: '\x1b[35m',
  ok: '\x1b[32m',
  dim: '\x1b[2m',
  reset: '\x1b[0m'
};

const logFile = path.join(config.paths.logs, 'pipeline.log');

function writeToFile(level, scope, message, meta) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta: safeMeta(meta) } : {})
  });
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    /* logging must never break the pipeline */
  }
}

function safeMeta(meta) {
  try {
    return JSON.parse(JSON.stringify(meta));
  } catch {
    return '[unserialisable]';
  }
}

function emit(level, colorTag, prefix, scope, message, meta) {
  if (LEVELS[level] < activeLevel) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const c = useColor ? COLOR[colorTag] : '';
  const dim = useColor ? COLOR.dim : '';
  const reset = useColor ? COLOR.reset : '';
  const head = `${dim}${stamp}${reset} ${c}${prefix}${reset}${scope ? ` ${dim}${scope}${reset}` : ''}`;
  const line = meta ? `${head} ${message} ${dim}${JSON.stringify(safeMeta(meta))}${reset}` : `${head} ${message}`;
  (level === 'error' ? console.error : console.log)(line);
  writeToFile(level, scope, message, meta);
}

export function createLogger(scope = '') {
  return {
    debug: (m, meta) => emit('debug', 'debug', '· ', scope, m, meta),
    info: (m, meta) => emit('info', 'info', 'ℹ ', scope, m, meta),
    warn: (m, meta) => emit('warn', 'warn', '⚠ ', scope, m, meta),
    error: (m, meta) => emit('error', 'error', '✖ ', scope, m, meta),
    step: (m) => emit('info', 'step', '▸ ', scope, m),
    ok: (m, meta) => emit('info', 'ok', '✔ ', scope, m, meta)
  };
}

export const log = createLogger();
