import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

export const config = {
  brand: raw.brand,
  news: raw.news,
  llm: raw.llm,
  reel: raw.reel,
  publish: raw.publish,
  paths: {
    root: ROOT,
    output: path.join(ROOT, 'output'),
    state: path.join(ROOT, 'state'),
    coveredEvents: path.join(ROOT, 'state', 'coveredEvents.json'),
    runs: path.join(ROOT, 'state', 'runs.json'),
    pendingPosts: path.join(ROOT, 'state', 'pendingPosts.json'),
    logs: path.join(ROOT, 'logs'),
    assets: path.join(ROOT, 'src', 'assets'),
    templates: path.join(ROOT, 'src', 'templates')
  }
};

export const env = {
  groqApiKey: process.env.GROQ_API_KEY,
  pexelsApiKey: process.env.PEXELS_API_KEY,
  facebook: {
    appId: process.env.FACEBOOK_APP_ID,
    pageId: process.env.FACEBOOK_PAGE_ID,
    pageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
    userAccessToken: process.env.FACEBOOK_USER_ACCESS_TOKEN,
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION || 'v26.0'
  },
  linkedin: {
    memberId: process.env.LINKEDIN_MEMBER_ID,
    accessToken: process.env.LINKEDIN_ACCESS_TOKEN,
    apiVersion: process.env.LINKEDIN_API_VERSION || '202601'
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  port: Number(process.env.PORT || 4000)
};

/**
 * Reports which credentials are present so a failure mid-pipeline is obvious
 * instead of surfacing as an opaque 401.
 */
export function credentialStatus() {
  return {
    'GROQ_API_KEY': Boolean(env.groqApiKey),
    'PEXELS_API_KEY': Boolean(env.pexelsApiKey),
    'FACEBOOK_APP_ID': Boolean(env.facebook.appId),
    'FACEBOOK_PAGE_ID': Boolean(env.facebook.pageId),
    'FACEBOOK_PAGE_ACCESS_TOKEN': Boolean(env.facebook.pageAccessToken),
    'FACEBOOK_USER_ACCESS_TOKEN': Boolean(env.facebook.userAccessToken),
    'LINKEDIN_MEMBER_ID': Boolean(env.linkedin.memberId),
    'LINKEDIN_ACCESS_TOKEN': Boolean(env.linkedin.accessToken),
    'TELEGRAM_BOT_TOKEN': Boolean(env.telegram.botToken),
    'TELEGRAM_CHAT_ID': Boolean(env.telegram.chatId)
  };
}

for (const dir of [config.paths.output, config.paths.state, config.paths.logs]) {
  fs.mkdirSync(dir, { recursive: true });
}
