import 'dotenv/config';

/**
 * Prints the chat id Telegram associates with you, so TELEGRAM_CHAT_ID can be
 * set without guessing.
 *
 * Telegram bots cannot open a conversation: until you send the bot a message,
 * the bot cannot resolve your chat and every send fails with "chat not found".
 *
 *   1. Open Telegram, find the bot, press Start (or just type "hi").
 *   2. Run: npm run telegram:chatid
 *   3. Paste the printed line into .env
 */

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`);
const data = await res.json().catch(() => ({}));

if (!data.ok) {
  console.error(`getUpdates failed: ${data.description || `HTTP ${res.status}`}`);
  process.exit(1);
}

if (!data.result.length) {
  console.log('\nNo messages yet.\n');
  console.log('Telegram will not let a bot message you until you message it first:');
  console.log('  1. Open Telegram and search for your bot');
  console.log('  2. Press Start (or send any message, e.g. "hi")');
  console.log('  3. Run this command again\n');
  process.exit(1);
}

const chats = new Map();
for (const update of data.result) {
  const chat = update.message?.chat || update.channel_post?.chat;
  if (!chat) continue;
  chats.set(chat.id, chat);
}

console.log('\nFound chat(s) that have messaged this bot:\n');
for (const [id, chat] of chats) {
  const who = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || '(unknown)';
  console.log(`  type : ${chat.type}`);
  console.log(`  name : ${who}`);
  console.log(`  id   : ${id}`);
  console.log(`\n  TELEGRAM_CHAT_ID=${id}`);
  console.log(`  # ${who}, ${chat.type}\n`);
}

if (chats.size > 1) {
  console.log('More than one chat has written. Pick the one you want to receive reels on.\n');
}
