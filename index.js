import 'dotenv/config';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Redis from 'ioredis';
import PQueue from 'p-queue';

const {
  TELEGRAM_TOKEN,
  SUBGRAPH_URL,
  EXPLORER_TX_URL = 'https://explorer.beschyperchain.com/tx/',
  GECKO_NETWORK = 'besc-hyperchain',
  REDIS_URL,
  POLL_INTERVAL_MS = '400'
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');
if (!SUBGRAPH_URL) throw new Error('Missing SUBGRAPH_URL');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;
const queue = new PQueue({ interval: Number(POLL_INTERVAL_MS), intervalCap: 5 });

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on :' + PORT));

const memoryStore = new Map();
const pendingVideo = new Map();
const awaitingTokenInput = new Map();
const awaitingMinBuyInput = new Map();
const awaitingTierInput = new Map();
const awaitingRemoveChoice = new Map();
const compWizard = new Map();

// Global error handler
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// -------- Config helpers --------
function defaultChatConfig() {
  return {
    pools: [],
    minBuyUsd: 0,
    videoUrl: null,
    videoFileId: null,
    videoChatId: null,
    videoValid: false,
    threadId: null,
    emoji: { small: '🟢', mid: '💎', large: '🐋' },
    tiers: { small: 100, large: 1000 },
    tokenSymbols: {},
    showSells: false,
    activeCompetition: null
  };
}

async function getChat(chatId) {
  if (!redis) return memoryStore.get(chatId) || defaultChatConfig();
  const raw = await redis.get(`chat:${chatId}:config`);
  if (raw) return JSON.parse(raw);
  const cfg = defaultChatConfig();
  await redis.set(`chat:${chatId}:config`, JSON.stringify(cfg));
  return cfg;
}

async function setChat(chatId, cfg) {
  if (!redis) memoryStore.set(chatId, cfg);
  else await redis.set(`chat:${chatId}:config`, JSON.stringify(cfg));
}

function tierEmoji(cfg, usd) {
  if (usd >= cfg.tiers.large) return cfg.emoji.large;
  if (usd >= cfg.tiers.small) return cfg.emoji.mid;
  return cfg.emoji.small;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatUSD(n, maxFraction = 0) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100000) {
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFraction });
}

function adjustSupply(supplyLike, decimals = 18) {
  if (supplyLike == null) return 0;
  const str = String(supplyLike);
  if (str.includes('.') || str.toLowerCase().includes('e')) {
    const n = Number(str);
    return Number.isFinite(n) ? n : 0;
  }
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    if (!Number.isFinite(n)) return 0;
    if (str.length > (Number(decimals) + 2)) {
      return n / Math.pow(10, Number(decimals));
    }
    return n;
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
}

// -------- Subgraph Queries --------
async function fetchTopPoolForToken(tokenAddr) {
  const query = `
  {
    pairs(
      first: 1
      orderBy: reserveUSD
      orderDirection: desc
      where: {
        or: [
          { token0: "${tokenAddr.toLowerCase()}" }
          { token1: "${tokenAddr.toLowerCase()}" }
        ]
      }
    ) {
      id
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      reserveUSD
    }
  }`;

  try {
    const { data } = await axios.post(process.env.SUBGRAPH_URL, { query });
    const pairs = data?.data?.pairs || [];
    if (!pairs.length) return null;

    const pair = pairs[0];
    const symbol = pair.token0.id.toLowerCase() === tokenAddr.toLowerCase()
      ? pair.token0.symbol
      : pair.token1.symbol;
    const decimals = pair.token0.id.toLowerCase() === tokenAddr.toLowerCase()
      ? pair.token0.decimals
      : pair.token1.decimals;

    return { pool: pair.id, symbol, decimals };
  } catch (e) {
    console.error(`[Subgraph] Failed to fetch pool for ${tokenAddr}:`, e.message);
    return null;
  }
}

async function fetchTradesForPool(pairAddr) {
  const query = `
  {
    swaps(
      first: 5
      orderBy: timestamp
      orderDirection: desc
      where: { pair: "${pairAddr.toLowerCase()}" }
    ) {
      id
      transaction { id }
      sender
      to
      pair {
        token0 { symbol id decimals }
        token1 { symbol id decimals }
      }
      amount0In
      amount1In
      amount0Out
      amount1Out
      timestamp
    }
  }`;

  try {
    const { data } = await axios.post(process.env.SUBGRAPH_URL, { query });
    return data?.data?.swaps || [];
  } catch (e) {
    console.error(`[Subgraph] Failed for pair ${pairAddr}:`, e.message);
    return [];
  }
}

async function fetchPairStats(pairAddr) {
  const query = `
  {
    pairDayDatas(
      first: 1
      orderBy: date
      orderDirection: desc
      where: { pair: "${pairAddr.toLowerCase()}" }
    ) {
      reserveUSD
      dailyVolumeUSD
      token0Price
      token1Price
    }
  }`;

  try {
    const { data } = await axios.post(process.env.SUBGRAPH_URL, { query });
    return data?.data?.pairDayDatas[0] || {};
  } catch (e) {
    console.error(`[Subgraph] Failed to fetch pair stats for ${pairAddr}:`, e.message);
    return {};
  }
}

// -------- Video validation --------
async function validateVideoFileId(chatId, fileId) {
  try {
    console.log(`[VIDEO] Attempting to validate file_id: ${fileId}`);
    const file = await bot.getFile(fileId);
    console.log(`[VIDEO] File info:`, {
      file_path: file.file_path,
      file_size: file.file_size,
      mime_type: file.mime_type,
      file_unique_id: file.file_unique_id
    });

    if (!file.file_path) {
      console.warn(`[VIDEO] No file_path for ${fileId}`);
      return false;
    }

    if (file.file_size >= 50 * 1024 * 1024) {
      console.warn(`[VIDEO] File too large: ${file.file_size} bytes`);
      return false;
    }

    const isVideo = file.mime_type?.startsWith('video/') ||
                    file.file_path?.includes('.mp4') ||
                    file.file_path?.includes('.mov') ||
                    file.file_path?.includes('.avi') ||
                    file.mime_type === 'application/octet-stream';

    if (!isVideo) {
      console.warn(`[VIDEO] Not recognized as video: mime=${file.mime_type}, path=${file.file_path}`);
      return true; // Lenient mode
    }

    console.log(`[VIDEO] ✅ Validated file_id ${fileId} for chat ${chatId}`);
    return true;
  } catch (error) {
    console.error(`[VIDEO] Failed to validate file_id ${fileId}:`, error.message);
    return true; // Lenient mode
  }
}

// -------- Safe video sender --------
async function safeSendVideo(chatId, videoConfig, caption, replyMarkup, threadId) {
  const { videoFileId, videoUrl, videoValid } = videoConfig;

  if (videoUrl) {
    try {
      console.log(`[VIDEO] Sending URL video: ${videoUrl}`);
      await bot.sendVideo(chatId, videoUrl, {
        caption,
        reply_markup: replyMarkup,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        message_thread_id: threadId,
        supports_streaming: true
      });
      return true;
    } catch (urlError) {
      console.warn(`[VIDEO] URL video failed: ${urlError.message}`);
    }
  }

  if (videoFileId && videoValid !== false) {
    try {
      console.log(`[VIDEO] Sending file_id video: ${videoFileId}`);
      await bot.sendVideo(chatId, videoFileId, {
        caption,
        reply_markup: replyMarkup,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        message_thread_id: threadId,
        supports_streaming: true
      });
      return true;
    } catch (fileError) {
      console.error(`[VIDEO] File_id video failed: ${fileError.message}`);
      const cfg = await getChat(chatId);
      cfg.videoValid = false;
      await setChat(chatId, cfg);
      console.log(`[VIDEO] Marked video as invalid for chat ${chatId}`);
    }
  }

  console.log(`[VIDEO] Falling back to text for chat ${chatId}`);
  return false;
}

// -------- Settings Panel --------
async function sendSettingsPanel(chatId, messageId = null) {
  const cfg = await getChat(chatId);
  const tokens = cfg.pools.length
    ? cfg.pools.map(p => cfg.tokenSymbols[p] || (p.slice(0,6)+'…'+p.slice(-4))).join(', ')
    : 'None';
  const videoStatus = cfg.videoFileId ? (cfg.videoValid ? '✅ valid' : '⚠️ invalid') :
                     (cfg.videoUrl ? '🔗 URL' : '❌ none');

  const text =
    `⚙️ <b>Settings Panel</b>\n` +
    `<b>Tracking:</b> ${escapeHtml(tokens)}\n` +
    `<b>Min Buy:</b> $${cfg.minBuyUsd}\n` +
    `<b>Whale Tier:</b> $${cfg.tiers.large} | Mid $${cfg.tiers.small}\n` +
    `<b>Sells:</b> ${cfg.showSells ? 'ON' : 'OFF'}\n` +
    `<b>Video:</b> ${videoStatus}\n` +
    `<b>Competition:</b> ${cfg.activeCompetition ? '🏆 ACTIVE' : '—'}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Add Token', callback_data: 'add_token' },
       { text: '➖ Remove Token', callback_data: 'remove_token' }],
      [{ text: '🎯 Min Buy', callback_data: 'set_minbuy' },
       { text: '🐋 Whale Tier', callback_data: 'tier_menu' }],
      [{ text: cfg.showSells ? '🔴 Hide Sells' : '🟢 Show Sells', callback_data: 'toggle_sells' }],
      [
        { text: '🎞 Set Video', callback_data: 'set_video' },
        { text: '🗑 Remove Video', callback_data: 'remove_video' }
      ],
      [{ text: '🏆 Start Competition', callback_data: 'start_comp' },
       { text: '📊 Leaderboard', callback_data: 'show_leaderboard' },
       { text: '🛑 End Competition', callback_data: 'end_comp' }],
      [{ text: '📊 Status', callback_data: 'show_status' },
       { text: '🔄 Reset Thread', callback_data: 'reset_thread' }],
      [{ text: '✅ Done', callback_data: 'done_settings' }]
    ]
  };

  const opts = { message_thread_id: cfg.threadId || undefined };

  try {
    if (messageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: keyboard,
        ...opts
      });
    } else {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard, ...opts });
    }
  } catch (error) {
    if (error.message.includes("message can't be edited") || error.message.includes("message thread not found")) {
      console.warn(`[WARN] Could not edit/send settings panel for chat ${chatId}. Sending new message.`);
      try {
        if (messageId) await bot.deleteMessage(chatId, messageId, { ...opts });
      } catch (deleteErr) {
        console.warn(`[WARN] Could not delete message ${messageId}:`, deleteErr.message);
      }
      if (error.message.includes("message thread not found")) {
        cfg.threadId = null;
        await setChat(chatId, cfg);
        console.log(`[INFO] Cleared threadId for chat ${chatId} due to invalid topic`);
        await bot.sendMessage(chatId, '⚠️ Topic not found. Thread ID cleared. Please run /settings in a valid topic.', {});
      }
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      console.error(`[ERROR] Failed to send/edit settings panel for chat ${chatId}:`, error.message);
    }
  }
}

// -------- Handlers --------
bot.onText(/\/settings|\/start/, async (msg) => {
  const cfg = await getChat(msg.chat.id);
  if (msg.message_thread_id) {
    try {
      await bot.sendMessage(msg.chat.id, 'Validating topic...', { message_thread_id: msg.message_thread_id });
      cfg.threadId = msg.message_thread_id;
      await setChat(msg.chat.id, cfg);
      console.log(`[INFO] Captured threadId=${cfg.threadId} for chat ${msg.chat.id}`);
      await bot.deleteMessage(msg.chat.id, (await bot.getUpdates({ limit: 1 }))[0].message.message_id);
    } catch (error) {
      console.warn(`[WARN] Invalid thread ID ${msg.message_thread_id} for chat ${msg.chat.id}:`, error.message);
      cfg.threadId = null;
      await setChat(msg.chat.id, cfg);
      console.log(`[INFO] Cleared threadId for chat ${msg.chat.id} (invalid topic)`);
      await bot.sendMessage(msg.chat.id, '⚠️ Invalid topic. Please run /settings in a valid topic.', {});
    }
  } else {
    cfg.threadId = null;
    await setChat(msg.chat.id, cfg);
    console.log(`[INFO] Cleared threadId for chat ${msg.chat.id} (no message_thread_id)`);
  }
  await sendSettingsPanel(msg.chat.id);
});

bot.onText(/\/resetchat/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  await redis?.del(`chat:${chatId}:config`);
  memoryStore.delete(chatId);
  await bot.sendMessage(chatId, '✅ Chat configuration reset. Use /settings to re-add pools.', { ...opts });
});

bot.onText(/\/resetthread/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  cfg.threadId = null;
  await setChat(chatId, cfg);
  console.log(`[INFO] Cleared threadId for chat ${chatId} via /resetthread`);
  await bot.sendMessage(chatId, '✅ Topic thread ID cleared. Run /settings in a valid topic to set a new one.', { ...opts });
});

bot.onText(/\/resetpool (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const poolId = match[1].trim();
  await redis?.del(`pool:${poolId}:lastTradeId`);
  memoryStore.delete(`pool:${poolId}:lastTradeId`);
  await bot.sendMessage(chatId, `✅ Cleared lastTradeId for pool ${poolId}. Next trade will trigger.`, { ...opts });
});

bot.onText(/\/removevideo/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  cfg.videoFileId = null;
  cfg.videoUrl = null;
  cfg.videoChatId = null;
  cfg.videoValid = false;
  await setChat(chatId, cfg);
  await bot.sendMessage(chatId, '🗑 Video removed. Alerts will use text only.', { ...opts });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  await bot.answerCallbackQuery(query.id);

  switch (query.data) {
    case 'add_token':
      awaitingTokenInput.set(chatId, query.message.message_id);
      await bot.sendMessage(chatId, 'Reply with token address (0x...) to add:', { ...opts });
      break;

    case 'remove_token':
      if (!cfg.pools.length) {
        await bot.sendMessage(chatId, 'No tokens to remove.', { ...opts });
        return;
      }
      const rows = cfg.pools.map(p => ([{ text: (cfg.tokenSymbols[p] || p.slice(0,6)+'…'+p.slice(-4)), callback_data: `rm:${p}` }]));
      rows.push([{ text: '⬅️ Back', callback_data: 'back_to_settings' }]);
      try {
        await bot.editMessageText('Select a token to remove:', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: rows },
          ...opts
        });
      } catch (error) {
        if (error.message.includes("message can't be edited") || error.message.includes("message thread not found")) {
          console.warn(`[WARN] Could not edit remove_token message in chat ${chatId}. Sending new message.`);
          try {
            await bot.deleteMessage(chatId, query.message.message_id, { ...opts });
          } catch (deleteErr) {
            console.warn(`[WARN] Could not delete message ${query.message.message_id}:`, deleteErr.message);
          }
          if (error.message.includes("message thread not found")) {
            cfg.threadId = null;
            await setChat(chatId, cfg);
            console.log(`[INFO] Cleared threadId for chat ${chatId} due to invalid topic`);
            await bot.sendMessage(chatId, '⚠️ Topic not found. Thread ID cleared. Please run /settings in a valid topic.', {});
          }
          await bot.sendMessage(chatId, 'Select a token to remove:', {
            reply_markup: { inline_keyboard: rows }
          });
        } else {
          console.error(`[ERROR] Failed to edit remove_token message for chat ${chatId}:`, error.message);
        }
      }
      awaitingRemoveChoice.set(chatId, query.message.message_id);
      break;

    case 'done_settings':
      try {
        await bot.deleteMessage(chatId, query.message.message_id, { ...opts });
      } catch (deleteErr) {
        console.warn(`[WARN] Could not delete settings message ${query.message.message_id}:`, deleteErr.message);
      }
      await bot.sendMessage(chatId, '✅ Settings updated.', { ...opts });
      break;

    case 'set_minbuy':
      awaitingMinBuyInput.set(chatId, query.message.message_id);
      await bot.sendMessage(chatId, 'Reply with minimum buy USD value (e.g. 50):', { ...opts });
      break;

    case 'tier_menu':
      try {
        await bot.editMessageText(
          `🐋 Adjust Whale & Mid Tier Thresholds:\nCurrent: Small $${cfg.tiers.small}, Large $${cfg.tiers.large}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: `Small: $${cfg.tiers.small}`, callback_data: 'set_tier_small' },
                 { text: `Large: $${cfg.tiers.large}`, callback_data: 'set_tier_large' }],
                [{ text: '⬅️ Back', callback_data: 'back_to_settings' }]
              ]
            },
            ...opts
          }
        );
      } catch (error) {
        if (error.message.includes("message can't be edited") || error.message.includes("message thread not found")) {
          console.warn(`[WARN] Could not edit tier_menu message in chat ${chatId}. Sending new message.`);
          try {
            await bot.deleteMessage(chatId, query.message.message_id, { ...opts });
          } catch (deleteErr) {
            console.warn(`[WARN] Could not delete message ${query.message.message_id}:`, deleteErr.message);
          }
          if (error.message.includes("message thread not found")) {
            cfg.threadId = null;
            await setChat(chatId, cfg);
            console.log(`[INFO] Cleared threadId for chat ${chatId} due to invalid topic`);
            await bot.sendMessage(chatId, '⚠️ Topic not found. Thread ID cleared. Please run /settings in a valid topic.', {});
          }
          await bot.sendMessage(chatId,
            `🐋 Adjust Whale & Mid Tier Thresholds:\nCurrent: Small $${cfg.tiers.small}, Large $${cfg.tiers.large}`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: `Small: $${cfg.tiers.small}`, callback_data: 'set_tier_small' },
                   { text: `Large: $${cfg.tiers.large}`, callback_data: 'set_tier_large' }],
                  [{ text: '⬅️ Back', callback_data: 'back_to_settings' }]
                ]
              }
            }
          );
        } else {
          console.error(`[ERROR] Failed to edit tier_menu message for chat ${chatId}:`, error.message);
        }
      }
      break;

    case 'set_tier_small':
      awaitingTierInput.set(chatId, { which: 'small', msg: query.message.message_id });
      await bot.sendMessage(chatId, 'Reply with new SMALL tier value (USD):', { ...opts });
      break;

    case 'set_tier_large':
      awaitingTierInput.set(chatId, { which: 'large', msg: query.message.message_id });
      await bot.sendMessage(chatId, 'Reply with new LARGE tier value (USD):', { ...opts });
      break;

    case 'toggle_sells':
      cfg.showSells = !cfg.showSells;
      await setChat(chatId, cfg);
      await bot.answerCallbackQuery(query.id, { text: `Sell alerts ${cfg.showSells ? 'ON' : 'OFF'}` });
      await sendSettingsPanel(chatId, query.message.message_id);
      break;

    case 'set_video':
      pendingVideo.set(chatId, true);
      await bot.sendMessage(chatId,
        '📹 Send the video (MP4, max 50MB) you want to use for alerts.\n' +
        'Or reply with a direct MP4 URL.', 
        { ...opts }
      );
      break;

    case 'remove_video':
      cfg.videoFileId = null;
      cfg.videoUrl = null;
      cfg.videoChatId = null;
      cfg.videoValid = false;
      await setChat(chatId, cfg);
      await bot.answerCallbackQuery(query.id, { text: 'Video removed.' });
      await sendSettingsPanel(chatId, query.message.message_id);
      break;

    case 'reset_thread':
      cfg.threadId = null;
      await setChat(chatId, cfg);
      console.log(`[INFO] Cleared threadId for chat ${chatId} via reset_thread callback`);
      await bot.answerCallbackQuery(query.id, { text: 'Thread ID cleared.' });
      await bot.sendMessage(chatId, '✅ Topic thread ID cleared. Run /settings in a valid topic to set a new one.', {});
      await sendSettingsPanel(chatId, query.message.message_id);
      break;

    case 'show_status':
      await bot.sendMessage(chatId, 'Use /status to view full configuration.', { ...opts });
      break;

    case 'back_to_settings':
      await sendSettingsPanel(chatId, query.message.message_id);
      break;

    case 'start_comp':
      compWizard.set(chatId, { step: 1, data: {} });
      await bot.sendMessage(chatId, '🏆 Enter duration (minutes):', { ...opts });
      break;

    case 'show_leaderboard':
      await postLeaderboard(chatId);
      break;

    case 'end_comp':
      if (cfg.activeCompetition) {
        await postLeaderboard(chatId, true);
        cfg.activeCompetition = null;
        await setChat(chatId, cfg);
        await bot.sendMessage(chatId, '🛑 Competition ended.', { ...opts });
      } else {
        await bot.sendMessage(chatId, 'No active competition.', { ...opts });
      }
      break;

    default:
      if (query.data.startsWith('rm:')) {
        const pool = query.data.slice(3);
        const cfg2 = await getChat(chatId);
        if (cfg2.pools.includes(pool)) {
          cfg2.pools = cfg2.pools.filter(p => p !== pool);
          delete cfg2.tokenSymbols[pool];
          await setChat(chatId, cfg2);
          await bot.answerCallbackQuery(query.id, { text: 'Removed.' });
        } else {
          await bot.answerCallbackQuery(query.id, { text: 'Not found.' });
        }
        const msgId = awaitingRemoveChoice.get(chatId) || query.message.message_id;
        awaitingRemoveChoice.delete(chatId);
        await sendSettingsPanel(chatId, msgId);
      }
      break;
  }
});

// -------- Message Handler --------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };

  if (msg.text && msg.text.startsWith('/')) return;

  if (pendingVideo.has(chatId)) {
    if (msg.video || (msg.document && msg.document.mime_type?.startsWith('video/'))) {
      let fileId;
      let fileInfo = {};

      if (msg.video) {
        fileId = msg.video.file_id;
        fileInfo = {
          type: 'video',
          file_id: fileId,
          file_size: msg.video.file_size,
          duration: msg.video.duration,
          mime_type: msg.video.mime_type,
          width: msg.video.width,
          height: msg.video.height
        };
      } else if (msg.document) {
        fileId = msg.document.file_id;
        fileInfo = {
          type: 'document',
          file_id: fileId,
          file_size: msg.document.file_size,
          mime_type: msg.document.mime_type,
          file_name: msg.document.file_name
        };
      }

      console.log(`[VIDEO] Received video info:`, fileInfo);
      const isValid = await validateVideoFileId(chatId, fileId);

      cfg.videoFileId = fileId;
      cfg.videoUrl = null;
      cfg.videoChatId = chatId;
      cfg.videoValid = isValid;
      await setChat(chatId, cfg);
      pendingVideo.delete(chatId);

      const status = isValid ? '✅ Video saved and validated!' : '⚠️ Video saved (validation warning - will try anyway)';
      await bot.sendMessage(chatId,
        `${status}\nWill play on every buy alert in this chat.\n\n` +
        `File ID: \`${fileId}\`\n` +
        `Size: ${fileInfo.file_size || 'unknown'} bytes\n` +
        `Type: ${fileInfo.type}`, 
        { parse_mode: 'HTML', ...opts }
      );

      setTimeout(async () => {
        try {
          await bot.sendVideo(chatId, fileId, {
            caption: '🧪 Test video - if you see this, video works!',
            message_thread_id: cfg.threadId || undefined,
            supports_streaming: true
          });
          console.log(`[VIDEO] Test send successful for ${fileId}`);
        } catch (testError) {
          console.error(`[VIDEO] Test send failed for ${fileId}:`, testError.message);
          const cfg2 = await getChat(chatId);
          cfg2.videoValid = false;
          await setChat(chatId, cfg2);
          await bot.sendMessage(chatId,
            `⚠️ Test send failed - video marked invalid. Use /removevideo and try again.`,
            { ...opts }
          );
        }
      }, 3000);
    } else if (msg.text && msg.text.startsWith('http')) {
      const url = msg.text.trim();
      console.log(`[VIDEO] Received URL: ${url}`);

      cfg.videoUrl = url;
      cfg.videoFileId = null;
      cfg.videoChatId = chatId;
      cfg.videoValid = true;
      await setChat(chatId, cfg);
      pendingVideo.delete(chatId);

      await bot.sendMessage(chatId,
        `✅ Video URL saved!\nWill use this MP4 for every buy alert.`,
        { ...opts }
      );
    } else {
      await bot.sendMessage(chatId,
        '❌ Please send a video file (MP4) or a direct MP4 URL.',
        { ...opts }
      );
    }
    return;
  }

  if (!msg.text) return;

  if (awaitingTokenInput.has(chatId)) {
    const token = msg.text.trim();
    const isAddr = /^0x[a-fA-F0-9]{40}$/.test(token);
    const msgId = awaitingTokenInput.get(chatId);
    awaitingTokenInput.delete(chatId);
    if (!isAddr) {
      await bot.sendMessage(chatId, '❌ Invalid address. Please send a valid 0x token address.', { ...opts });
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    const top = await fetchTopPoolForToken(token);
    if (top) {
      const cfg = await getChat(chatId);
      if (!cfg.pools.includes(top.pool)) cfg.pools.push(top.pool);
      cfg.tokenSymbols[top.pool] = top.symbol || 'TOKEN';
      await setChat(chatId, cfg);
      await bot.sendMessage(chatId, `✅ Tracking ${top.symbol} (${top.pool.slice(0,6)}…${top.pool.slice(-4)})`, { ...opts });
      await sendSettingsPanel(chatId, msgId);
    } else {
      await bot.sendMessage(chatId, '❌ No pool found for that token.', { ...opts });
      await sendSettingsPanel(chatId, msgId);
    }
    return;
  }

  if (awaitingMinBuyInput.has(chatId)) {
    const val = Number(msg.text);
    const msgId = awaitingMinBuyInput.get(chatId);
    awaitingMinBuyInput.delete(chatId);
    if (!Number.isFinite(val) || val < 0) {
      await bot.sendMessage(chatId, '❌ Please enter a valid non-negative number.', { ...opts });
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    const cfg = await getChat(chatId);
    cfg.minBuyUsd = val;
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, `✅ Min buy set to $${val}`, { ...opts });
    await sendSettingsPanel(chatId, msgId);
    return;
  }

  if (awaitingTierInput.has(chatId)) {
    const { which, msg: msgId } = awaitingTierInput.get(chatId);
    awaitingTierInput.delete(chatId);
    const val = Number(msg.text);
    if (!Number.isFinite(val) || val < 0) {
      await bot.sendMessage(chatId, '❌ Please enter a valid non-negative number.', { ...opts });
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    const cfg = await getChat(chatId);
    cfg.tiers[which] = val;
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, `✅ ${which.toUpperCase()} tier set to $${val}`, { ...opts });
    await sendSettingsPanel(chatId, msgId);
    return;
  }

  if (compWizard.has(chatId)) {
    const wizard = compWizard.get(chatId);
    const data = wizard.data;
    if (wizard.step === 1) {
      const minutes = Number(msg.text);
      if (!minutes || minutes < 1) return bot.sendMessage(chatId, 'Enter a valid duration in minutes:', { ...opts });
      data.duration = minutes;
      wizard.step = 2;
      return bot.sendMessage(chatId, 'Enter minimum buy USD to qualify:', { ...opts });
    }
    if (wizard.step === 2) {
      data.minBuyUsd = Number(msg.text) || 0;
      wizard.step = 3;
      return bot.sendMessage(chatId, 'Enter prize for 🥇 1st place:', { ...opts });
    }
    if (wizard.step === 3) {
      data.prize1 = msg.text;
      wizard.step = 4;
      return bot.sendMessage(chatId, 'Enter prizes for 🥈 2nd and 🥉 3rd (comma separated):', { ...opts });
    }
    if (wizard.step === 4) {
      const [p2, p3] = msg.text.split(',').map(x => x.trim());
      data.prizes = [data.prize1, p2, p3];
      const cfg = await getChat(chatId);
      cfg.activeCompetition = {
        endsAt: Date.now() + data.duration * 60 * 1000,
        minBuyUsd: data.minBuyUsd,
        prizes: data.prizes,
        leaderboard: {}
      };
      await setChat(chatId, cfg);
      compWizard.delete(chatId);
      await bot.sendMessage(chatId,
        `🎉 Big Buy Competition Started!\n⏳ ${data.duration} min\n💵 Min Buy $${data.minBuyUsd}\n` +
        `🥇 ${data.prizes[0]}\n🥈 ${data.prizes[1]}\n🥉 ${data.prizes[2]}`, { ...opts });
      await sendSettingsPanel(chatId);
      return;
    }
  }
});

// -------- Commands --------
bot.onText(/\/testvideo (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const opts = { message_thread_id: (await getChat(chatId)).threadId || undefined };
  const fileId = match[1].trim();

  if (!fileId) {
    return bot.sendMessage(chatId, 'Usage: /testvideo <file_id>', { ...opts });
  }

  const isValid = await validateVideoFileId(chatId, fileId);
  await bot.sendMessage(chatId,
    `Video validation result for ${fileId}:\n` +
    `Status: ${isValid ? '✅ VALID' : '❌ INVALID'}\n` +
    `Chat: ${chatId}`,
    { ...opts }
  );

  try {
    await bot.sendVideo(chatId, fileId, {
      caption: '🧪 Test video - if you see this, video works!',
      message_thread_id: opts.message_thread_id,
      supports_streaming: true
    });
    await bot.sendMessage(chatId, `✅ Test send successful!`, { ...opts });
  } catch (testError) {
    await bot.sendMessage(chatId,
      `❌ Test send failed: ${testError.message}`,
      { ...opts }
    );
  }
});

bot.onText(/\/add (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const token = match[1];
  const top = await fetchTopPoolForToken(token);
  if (!top) return bot.sendMessage(chatId, '❌ No pool found for that token.', { ...opts });
  if (!cfg.pools.includes(top.pool)) cfg.pools.push(top.pool);
  cfg.tokenSymbols[top.pool] = top.symbol || 'TOKEN';
  await setChat(chatId, cfg);
  const chart = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${top.pool}`;
  await bot.sendMessage(chatId, `✅ Tracking <b>${escapeHtml(top.symbol)}</b>\nPool: <code>${top.pool}</code>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '📈 Chart', url: chart }]] },
    ...opts
  });
});

bot.onText(/\/remove (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const token = match[1];
  const top = await fetchTopPoolForToken(token);
  if (!top) return bot.sendMessage(chatId, '❌ Could not resolve a pool for that token.', { ...opts });
  cfg.pools = cfg.pools.filter(p => p !== top.pool);
  delete cfg.tokenSymbols[top.pool];
  await setChat(chatId, cfg);
  await bot.sendMessage(chatId, `🛑 Stopped tracking pool ${top.pool}`, { ...opts });
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  if (!cfg.pools.length) return bot.sendMessage(chatId, 'No pools yet. Add with /add 0xYourToken or use /settings → Add Token', { ...opts });
  const lines = cfg.pools.map(p => `• <code>${p}</code> (${escapeHtml(cfg.tokenSymbols[p] || 'TOKEN')})`);
  await bot.sendMessage(chatId, `<b>Tracking:</b>\n${lines.join('\n')}`, { parse_mode: 'HTML', ...opts });
});

bot.onText(/\/minbuy (\d+(\.\d+)?)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const min = Number(match[1]);
  cfg.minBuyUsd = min;
  await setChat(chatId, cfg);
  await bot.sendMessage(chatId, `✅ Minimum buy set to $${min}`, { ...opts });
});

bot.onText(/\/setvideo(?: (https?:\/\/\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };

  if (match[1]) {
    cfg.videoUrl = match[1];
    cfg.videoFileId = null;
    cfg.videoChatId = chatId;
    cfg.videoValid = true;
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, '✅ Video URL set.', { ...opts });
  } else {
    pendingVideo.set(chatId, true);
    await bot.sendMessage(chatId,
      '📹 Send the MP4 video (max 50MB) for alerts.\n' +
      'Or send a direct MP4 URL next.',
      { ...opts }
    );
  }
});

bot.onText(/\/emoji (small|mid|large) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const which = match[1];
  const value = match[2];
  cfg.emoji[which] = value;
  await setChat(chatId, cfg);
  await bot.sendMessage(chatId, `✅ ${which} emoji → ${value}`, { ...opts });
});

bot.onText(/\/tier (small|large) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const which = match[1];
  const value = Number(match[2]);
  cfg.tiers[which] = value;
  await setChat(chatId, cfg);
  await bot.sendMessage(chatId, `✅ ${which} buy threshold set to $${value}`, { ...opts });
});

bot.onText(/\/showsells (on|off)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const value = match[1].toLowerCase() === 'on';
  cfg.showSells = value;
  await setChat(chatId, cfg);
  await bot.sendMessage(chatId, `✅ Sell alerts are now ${value ? 'ON' : 'OFF'}`, { ...opts });
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const pools = cfg.pools.length ? cfg.pools.map(p => `<code>${p}</code>`).join('\n') : 'None';
  const videoStatus = cfg.videoFileId ? (cfg.videoValid ? `✅ custom set (chat ${cfg.videoChatId})` : `⚠️ invalid file (chat ${cfg.videoChatId})`) :
                     (cfg.videoUrl ? `🔗 ${cfg.videoUrl}` : '❌ none');
  const statusText =
    `<b>Current Config</b>\n` +
    `Pools:\n${pools}\n\n` +
    `Min Buy: $${cfg.minBuyUsd}\n` +
    `Sells: ${cfg.showSells ? 'ON' : 'OFF'}\n` +
    `Whale Tier: $${cfg.tiers.large}, Mid Tier: $${cfg.tiers.small}\n` +
    `Video: ${videoStatus}\n` +
    `Thread ID: ${cfg.threadId ? cfg.threadId : 'None'}\n` +
    `${cfg.activeCompetition ? '🏆 Big Buy Comp ACTIVE' : ''}`;
  await bot.sendMessage(chatId, statusText, { parse_mode: 'HTML', ...opts });
});

bot.onText(/\/ping/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  await bot.sendMessage(chatId, '✅ Bot is online and running.', { ...opts });
});

// -------- Leaderboard + Competition --------
async function postLeaderboard(chatId, final = false) {
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  if (!cfg.activeCompetition) return await bot.sendMessage(chatId, final ? 'No qualifying buys. Competition ended.' : 'No entries yet.', { ...opts });
  const lb = Object.entries(cfg.activeCompetition.leaderboard || {}).sort((a,b) => b[1] - a[1]);
  if (!lb.length) return await bot.sendMessage(chatId, final ? 'No qualifying buys. Competition ended.' : 'No entries yet.', { ...opts });
  let msg = final ? '🎉 <b>Big Buy Competition Over!</b>\n\n' : '📊 <b>Current Leaderboard</b>\n\n';
  lb.slice(0, 10).forEach(([wallet, amount], i) => {
    msg += `${['🥇','🥈','🥉'][i] || (i+1)+'.'} ${wallet.slice(0,6)}…${wallet.slice(-4)} — $${amount.toFixed(2)}\n`;
  });
  if (final && cfg.activeCompetition.prizes?.length) {
    msg += `\n🏆 Prizes:\n🥇 ${cfg.activeCompetition.prizes[0] || '-'}\n🥈 ${cfg.activeCompetition.prizes[1] || '-'}\n🥉 ${cfg.activeCompetition.prizes[2] || '-'}`;
  }
  await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', ...opts });
}

// -------- Auto-End Checker --------
setInterval(async () => {
  const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
  for (const k of keys) {
    const chatId = Number(k.split(':')[1]);
    const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
    if (cfg?.activeCompetition && Date.now() >= cfg.activeCompetition.endsAt) {
      await postLeaderboard(chatId, true);
      cfg.activeCompetition = null;
      await setChat(chatId, cfg);
    }
  }
}, 30000);

// -------- Pool polling + broadcasting --------
let poolRoundRobin = [];

async function refreshPoolSet() {
  try {
    const keys = redis
      ? await redis.keys('chat:*:config')
      : [...memoryStore.keys()].map(k => `chat:${k}:config`);

    const set = new Set();
    console.log(`[DEBUG] refreshPoolSet found ${keys.length} chat configs`);

    for (const k of keys) {
      const chatId = Number(k.split(':')[1]);
      let cfg;
      try {
        cfg = redis ? JSON.parse(await redis.get(k) || '{}') : memoryStore.get(chatId);
      } catch (err) {
        console.error(`[ERROR] Failed to parse config for chat ${chatId}:`, err.message);
        continue;
      }

      if (!cfg) {
        console.warn(`[WARN] No config for chat ${chatId}`);
        continue;
      }

      if (!cfg.pools || cfg.pools.length === 0) {
        console.debug(`[DEBUG] Chat ${chatId} has no pools configured`);
        continue;
      }

      cfg.pools.forEach((p) => {
        console.debug(`[DEBUG] Adding pool ${p} from chat ${chatId}`);
        set.add(p);
      });
    }

    poolRoundRobin = Array.from(set);
    console.log(`[INFO] poolRoundRobin now has ${poolRoundRobin.length} pools:`, poolRoundRobin);
  } catch (e) {
    console.error(`[ERROR] refreshPoolSet failed:`, e.message);
  }
}

refreshPoolSet();
setInterval(refreshPoolSet, 10000);

async function seen(pool, tradeId) {
  if (!tradeId) return false;
  const key = `pool:${pool}:lastTradeId`;
  const last = redis ? await redis.get(key) : memoryStore.get(key);
  if (last === tradeId) return true;
  if (redis) await redis.set(key, tradeId);
  else memoryStore.set(key, tradeId);
  return false;
}

async function safeSend(chatId, sendFn) {
  try {
    const cfg = await getChat(chatId);
    const opts = { message_thread_id: cfg.threadId || undefined };
    await sendFn(opts);
  } catch (e) {
    const desc = e.response?.body?.description || '';
    if (desc.includes('kicked') || desc.includes('forbidden') || desc.includes('group chat was upgraded to a supergroup chat')) {
      console.log(`[INFO] Chat ${chatId} is invalid. Cleaning config.`);
      if (redis) await redis.del(`chat:${chatId}:config`);
      else memoryStore.delete(chatId);
      try {
        await bot.sendMessage(chatId, '⚠️ Chat was upgraded or bot removed. Please run /settings to reconfigure.', {});
      } catch (notifyErr) {
        console.warn(`[WARN] Could not notify chat ${chatId}:`, notifyErr.message);
      }
    } else if (desc.includes('file_id') || desc.includes('not found') || desc.includes('message thread not found')) {
      console.warn(`[WARN] Invalid operation for chat ${chatId}. Falling back.`);
      const cfg = await getChat(chatId);
      if (desc.includes('message thread not found')) {
        cfg.threadId = null;
        await setChat(chatId, cfg);
        console.log(`[INFO] Cleared threadId for chat ${chatId} due to invalid topic`);
        try {
          await bot.sendMessage(chatId, '⚠️ Topic not found. Thread ID cleared. Please run /settings in a valid topic.', {});
        } catch (notifyErr) {
          console.warn(`[WARN] Could not notify chat ${chatId}:`, notifyErr.message);
        }
      }
      await sendFn({});
    } else {
      console.error(`[ERROR] Telegram send failed for chat ${chatId}:`, e.message, desc);
    }
  }
}

async function broadcastTrade(pool, trade) {
  const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
  for (const k of keys) {
    const chatId = Number(k.split(':')[1]);
    const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
    if (!cfg || !cfg.pools.includes(pool)) continue;
    if (trade.tradeType === 'sell' && cfg.showSells === false) continue;

    const stats = await fetchPairStats(pool);
    const isToken0WBESC = trade.pair.token0.id.toLowerCase() === '0x33e22F85CC1877697773ca5c85988663388883A0'.toLowerCase(); // Replace with actual WBESC address
    const price = isToken0WBESC ? stats.token1Price : stats.token0Price;
    const amountTok = adjustSupply(isToken0WBESC ? (trade.amount1Out || trade.amount1In) : (trade.amount0Out || trade.amount0In), trade.pair[isToken0WBESC ? 'token1' : 'token0'].decimals);
    const usd = price && amountTok ? Number(price) * Number(amountTok) : 0;

    if (usd < (cfg.minBuyUsd || 0)) continue;

    if (cfg.activeCompetition) {
      cfg.activeCompetition.leaderboard[trade.sender || trade.transaction.id] =
        (cfg.activeCompetition.leaderboard[trade.sender || trade.transaction.id] || 0) + usd;
      await setChat(chatId, cfg);
    }

    let extraData = '';
    if (stats.reserveUSD) extraData += `💧 Liquidity: $${formatUSD(Number(stats.reserveUSD))}\n`;
    if (stats.dailyVolumeUSD) extraData += `📈 24h Vol: $${formatUSD(Number(stats.dailyVolumeUSD))}\n`;
    if (price) extraData += `💹 Price: $${formatUSD(Number(price), 6)}\n`;

    const isSell = trade.tradeType === 'sell';
    const emoji = isSell ? '🔴' : tierEmoji(cfg, usd);
    const action = isSell ? 'SELL' : 'BUY';
    const symbol = cfg.tokenSymbols[pool] || trade.pair.token0.symbol || trade.pair.token1.symbol || 'TOKEN';
    const priceStr = price ? `$${formatUSD(Number(price), 6)}` : '—';
    const txUrl = `${EXPLORER_TX_URL}${trade.transaction.id}`;
    const chart = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${pool}`;

    const caption =
      `${emoji} <b>${action}</b> • <b>${escapeHtml(symbol)}</b>\n` +
      `💵 <b>$${usd.toFixed(2)}</b>\n` +
      `🧮 ${amountTok.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${escapeHtml(symbol)} @ ${priceStr}\n` +
      extraData +
      (trade.sender ? `👤 ${escapeHtml(trade.sender.slice(0,6))}…${escapeHtml(trade.sender.slice(-4))}\n` : '') +
      `🔗 <a href="${txUrl}">TX</a> | <a href="${chart}">Chart</a>`;

    const replyMarkup = {
      inline_keyboard: [[{ text: '📈 Chart', url: chart }, { text: '🔎 TX', url: txUrl }]]
    };

    await safeSend(chatId, async (sendOpts) => {
      const usedVideo = await safeSendVideo(
        chatId,
        cfg,
        caption,
        replyMarkup,
        cfg.threadId
      );

      if (!usedVideo) {
        await bot.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          message_thread_id: cfg.threadId || undefined,
          reply_markup: replyMarkup
        });
      }
    });
  }
}

async function tickOnce() {
  if (!poolRoundRobin.length) return;
  const pool = poolRoundRobin.shift();
  poolRoundRobin.push(pool);
  const trades = await fetchTradesForPool(pool);
  if (!trades.length) return;
  const latest = trades[0];
  if (latest?.id && await seen(pool, latest.id)) return;

  if (latest?.id) {
    const isBuy =
      (latest.pair.token0.symbol === "WBESC" && Number(latest.amount0Out) > 0) ||
      (latest.pair.token1.symbol === "WBESC" && Number(latest.amount1Out) > 0);
    const isSell =
      (latest.pair.token0.symbol === "WBESC" && Number(latest.amount0In) > 0) ||
      (latest.pair.token1.symbol === "WBESC" && Number(latest.amount1In) > 0);

    latest.tradeType = isBuy ? "buy" : isSell ? "sell" : "other";
    await broadcastTrade(pool, latest);
  }
}

setInterval(() => queue.add(tickOnce).catch(console.error), Number(POLL_INTERVAL_MS));
console.log('Buy bot started with Subgraph:', SUBGRAPH_URL, 'and GeckoTerminal charts:', GECKO_NETWORK);
