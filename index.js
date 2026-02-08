import 'dotenv/config';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Redis from 'ioredis';
import PQueue from 'p-queue';

const {
  TELEGRAM_TOKEN,
  GECKO_NETWORK = 'besc-hyperchain',
  EXPLORER_TX_URL = 'https://explorer.beschyperchain.com/tx/',
  REDIS_URL,
  POLL_INTERVAL_MS = '100'
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

/**
 * ✅ Hard cap GeckoTerminal calls regardless of POLL_INTERVAL_MS
 * - 1 request/sec, sequential
 */
const queue = new PQueue({
  interval: 1000,
  intervalCap: 1,
  carryoverConcurrencyCount: true,
  concurrency: 1
});

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on :' + PORT));

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const memoryStore = new Map();

// State maps for inline flows
const pendingVideo = new Map();
const awaitingTokenInput = new Map();
const awaitingMinBuyInput = new Map();
const awaitingTierInput = new Map();
const awaitingRemoveChoice = new Map();
const compWizard = new Map();

// Global error handler to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ---------- small helpers ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(max = 250) {
  return Math.floor(Math.random() * max);
}

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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

// -------- FIXED: Robust Video validation helper --------
async function validateVideoFileId(chatId, fileId) {
  try {
    console.log(`[VIDEO] Attempting to validate file_id: ${fileId}`);
    const file = await bot.getFile(fileId);

    console.log(`[VIDEO] File info for ${fileId}:`, {
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

    const isVideo =
      file.mime_type?.startsWith('video/') ||
      file.file_path?.includes('.mp4') ||
      file.file_path?.includes('.mov') ||
      file.file_path?.includes('.avi') ||
      file.mime_type === 'application/octet-stream';

    if (!isVideo) {
      console.warn(`[VIDEO] Not recognized as video: mime=${file.mime_type}, path=${file.file_path}`);
      console.log(`[VIDEO] Accepting file anyway (lenient mode)`);
      return true;
    }

    console.log(`[VIDEO] ✅ Validated file_id ${fileId} for chat ${chatId}: ${file.file_path} (${file.file_size} bytes)`);
    return true;

  } catch (error) {
    console.error(`[VIDEO] Failed to validate file_id ${fileId}:`, error.message);
    console.log(`[VIDEO] Accepting file despite validation error (lenient mode)`);
    return true;
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

/**
 * ✅ GeckoTerminal hardening (FIXED):
 * - In-memory TTL cache
 * - In-flight de-dupe
 * - 429 backoff with MIN delay (prevents 0ms spin)
 * - Global cooldown (all requests pause after 429)
 * - Retry caps (never infinite attempts)
 */
const geckoCache = new Map();       // url -> { ts, ttl, data }
const geckoInflight = new Map();    // url -> Promise
let geckoGlobalCooldownUntil = 0;   // timestamp ms

function cacheGet(url) {
  const c = geckoCache.get(url);
  if (!c) return null;
  if (Date.now() - c.ts > c.ttl) return null;
  return c.data;
}

function cacheSet(url, data, ttl) {
  geckoCache.set(url, { ts: Date.now(), ttl, data });
}

async function geckoGet(url, ttlMs = 30000) {
  const cached = cacheGet(url);
  if (cached) return cached;

  const inflight = geckoInflight.get(url);
  if (inflight) return inflight;

  const p = (async () => {
    const MAX_429_RETRIES = 12;
    const MAX_TRANSIENT_RETRIES = 3;

    let attempt429 = 0;
    let attemptTransient = 0;

    let delay = 800; // base delay for backoff
    const MIN_BACKOFF_MS = 1000; // ✅ prevents 0ms spin
    const MAX_BACKOFF_MS = 15000;

    while (true) {
      // ✅ Global cooldown (if we got 429 anywhere, pause all requests)
      const now = Date.now();
      if (now < geckoGlobalCooldownUntil) {
        const wait = geckoGlobalCooldownUntil - now;
        await sleep(wait + jitter(200));
      }

      try {
        const res = await axios.get(url, {
          headers: { 'Accept': 'application/json;version=20230302' },
          timeout: 15000
        });

        cacheSet(url, res.data, ttlMs);
        return res.data;
      } catch (e) {
        const status = e?.response?.status;

        if (status === 429) {
          attempt429 += 1;

          const ra = e?.response?.headers?.['retry-after'];
          const raNum = ra != null ? Number(ra) : NaN;
          const retryAfterMs = Number.isFinite(raNum) ? raNum * 1000 : null;

          // ✅ enforce minimum wait even if retry-after=0
          const waitMs = Math.min(
            MAX_BACKOFF_MS,
            Math.max(MIN_BACKOFF_MS, retryAfterMs ?? delay)
          ) + jitter(250);

          // set global cooldown so ALL requests pause
          geckoGlobalCooldownUntil = Date.now() + waitMs;

          console.warn(
            `[GeckoTerminal] 429 rate-limited. Backing off ${waitMs}ms (429-attempt ${attempt429}). url=${url}`
          );

          if (attempt429 >= MAX_429_RETRIES) {
            const msg = `[GeckoTerminal] 429 limit reached (${MAX_429_RETRIES}). Skipping this cycle. url=${url}`;
            throw new Error(msg);
          }

          await sleep(waitMs);
          delay = Math.min(Math.floor(delay * 1.6), MAX_BACKOFF_MS);
          continue;
        }

        // transient: network/timeout/5xx
        if (!status || (status >= 500 && status <= 599)) {
          attemptTransient += 1;
          const waitMs = Math.min(MAX_BACKOFF_MS, Math.max(600, delay)) + jitter(250);

          console.warn(
            `[GeckoTerminal] transient error (status=${status || 'net'}). retry in ${waitMs}ms (attempt ${attemptTransient}). url=${url}`
          );

          if (attemptTransient > MAX_TRANSIENT_RETRIES) {
            throw e;
          }

          await sleep(waitMs);
          delay = Math.min(Math.floor(delay * 1.6), MAX_BACKOFF_MS);
          continue;
        }

        // non-retriable
        throw e;
      }
    }
  })();

  geckoInflight.set(url, p);

  try {
    return await p;
  } finally {
    geckoInflight.delete(url);
  }
}

// -------- GeckoTerminal wrappers --------
async function fetchTopPoolForToken(tokenAddr) {
  const url = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
  try {
    const data = await geckoGet(url, 5 * 60 * 1000);
    const pools = data?.data?.relationships?.top_pools?.data || [];
    if (!pools.length) return null;
    const poolId = pools[0].id;
    const pool = poolId.split('_').pop();
    const symbol = data?.data?.attributes?.symbol || 'TOKEN';
    return { pool, symbol };
  } catch (e) {
    console.error(`[GeckoTerminal] Failed to fetch top pool for ${tokenAddr}:`, e.response?.status, e.response?.data || e.message);
    return null;
  }
}

async function fetchTradesForPool(pool) {
  try {
    const url = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}/trades?limit=5`;
    // Tiny cache to stop burst loops
    const data = await geckoGet(url, 1500);
    return normalizeTrades(data?.data);
  } catch (e) {
    console.error(`[GeckoTerminal] Failed for pool ${pool}:`, e.response?.status, e.response?.data || e.message);
    if (e.response?.status === 404) {
      const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
      for (const k of keys) {
        const chatId = Number(k.split(':')[1]);
        const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
        if (cfg?.pools.includes(pool)) {
          await safeSend(chatId, async (opts) => {
            await bot.sendMessage(chatId, `⚠️ Pool ${pool} not found on network ${GECKO_NETWORK}. Please remove and re-add the token with /add.`, { ...opts });
          });
        }
      }
    }
    return [];
  }
}

function normalizeTrades(items) {
  return (items || []).map(x => {
    const a = x.attributes || {};
    const kind = (a.kind || '').toLowerCase();
    const isSell = kind === 'sell';
    const tokenAmount = Number(isSell ? a.from_token_amount : a.to_token_amount);
    return {
      id: x.id,
      tx: a.tx_hash,
      priceUsd: Number(a.price_to_in_usd ?? a.price_from_in_usd ?? 0),
      amountUsd: Number(a.volume_in_usd ?? 0),
      amountToken: tokenAmount,
      tradeType: kind,
      buyer: a.tx_from_address || null,
      fromToken: a.from_token_address,
      toToken: a.to_token_address,
      ts: a.block_timestamp
    }
  });
}

// -------- Inline Settings Panel --------
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
      await bot.sendMessage(msg.chat.id, '⚠️ Invalid topic. Please run /settings in a valid topic.', {});
    }
  } else {
    cfg.threadId = null;
    await setChat(msg.chat.id, cfg);
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
        console.warn(`[WARN] Could not edit remove_token message in chat ${chatId}. Sending new message.`);
        try { await bot.deleteMessage(chatId, query.message.message_id, { ...opts }); } catch {}
        await bot.sendMessage(chatId, 'Select a token to remove:', { reply_markup: { inline_keyboard: rows } });
      }
      awaitingRemoveChoice.set(chatId, query.message.message_id);
      break;

    case 'done_settings':
      try { await bot.deleteMessage(chatId, query.message.message_id, { ...opts }); } catch {}
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
      } catch {
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
            },
            ...opts
          }
        );
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
      await sendSettingsPanel(chatId, query.message.message_id);
      break;

    case 'reset_thread':
      cfg.threadId = null;
      await setChat(chatId, cfg);
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
        }
        const msgId = awaitingRemoveChoice.get(chatId) || query.message.message_id;
        awaitingRemoveChoice.delete(chatId);
        await sendSettingsPanel(chatId, msgId);
      }
      break;
  }
});

// -------- Single Message Handler --------
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
      } else {
        fileId = msg.document.file_id;
        fileInfo = {
          type: 'document',
          file_id: fileId,
          file_size: msg.document.file_size,
          mime_type: msg.document.mime_type,
          file_name: msg.document.file_name
        };
      }

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
        `File ID: <code>${escapeHtml(fileId)}</code>\n` +
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
        } catch (testError) {
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
      cfg.videoUrl = url;
      cfg.videoFileId = null;
      cfg.videoChatId = chatId;
      cfg.videoValid = true;
      await setChat(chatId, cfg);
      pendingVideo.delete(chatId);

      await bot.sendMessage(chatId, `✅ Video URL saved!`, { ...opts });
    } else {
      await bot.sendMessage(chatId, '❌ Please send a video file (MP4) or a direct MP4 URL.', { ...opts });
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
      await bot.sendMessage(chatId, '❌ No pool found for that token on this network.', { ...opts });
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
    for (const k of keys) {
      const chatId = Number(k.split(':')[1]);
      let cfg;
      try {
        cfg = redis ? JSON.parse(await redis.get(k) || '{}') : memoryStore.get(chatId);
      } catch {
        continue;
      }
      if (!cfg?.pools?.length) continue;
      cfg.pools.forEach((p) => set.add(p));
    }

    poolRoundRobin = Array.from(set);
    console.log(`[INFO] poolRoundRobin has ${poolRoundRobin.length} pools`);
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
    if (desc.includes('message thread not found')) {
      const cfg = await getChat(chatId);
      cfg.threadId = null;
      await setChat(chatId, cfg);
      await sendFn({});
      return;
    }
    await sendFn({}); // fallback no thread
  }
}

async function buildExtraDataForTrade(pool, trade) {
  let extraData = '';
  try {
    const tokenAddr = trade.toToken || trade.fromToken;
    if (!tokenAddr) return '';
    const tokenUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
    const poolUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}`;

    const [tokenData, poolData] = await Promise.all([
      geckoGet(tokenUrl, 60000),
      geckoGet(poolUrl, 60000)
    ]);

    const tokenAttr = tokenData?.data?.attributes || {};
    const poolAttr = poolData?.data?.attributes || {};
    const price = Number(trade.priceUsd || tokenAttr.price_usd || 0);

    let mcLabel = 'MC';
    let mcValue = Number(tokenAttr.market_cap_usd ?? 0);

    if (!mcValue && price > 0) {
      const circ = adjustSupply(tokenAttr.circulating_supply, tokenAttr.decimals ?? 18);
      if (circ > 0) mcValue = circ * price;
      else if (tokenAttr.fdv_usd) {
        mcValue = Number(tokenAttr.fdv_usd);
        mcLabel = 'FDV';
      } else {
        const total = adjustSupply(tokenAttr.total_supply, tokenAttr.decimals ?? 18);
        if (total > 0) {
          mcValue = total * price;
          mcLabel = 'FDV';
        }
      }
    }

    if (mcValue && mcValue > 0) extraData += `📊 ${mcLabel}: $${formatUSD(mcValue)}\n`;
    if (poolAttr.reserve_in_usd) extraData += `💧 Liquidity: $${formatUSD(Number(poolAttr.reserve_in_usd))}\n`;
    if (poolAttr.volume_usd_24h) extraData += `📈 24h Vol: $${formatUSD(Number(poolAttr.volume_usd_24h))}\n`;
    if (tokenAttr.price_percent_change_24h != null) {
      const pct = Number(tokenAttr.price_percent_change_24h);
      if (Number.isFinite(pct)) extraData += `📊 24h Change: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%\n`;
    }
    if (tokenAttr.unique_wallet_count) extraData += `👥 Holders: ${tokenAttr.unique_wallet_count}\n`;
  } catch (e) {
    console.warn(`[DEBUG] Extra data fetch failed:`, e.response?.status, e.response?.data || e.message);
  }
  return extraData;
}

async function broadcastTrade(pool, trade) {
  const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
  const sharedExtraData = await buildExtraDataForTrade(pool, trade);

  for (const k of keys) {
    const chatId = Number(k.split(':')[1]);
    const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
    if (!cfg || !cfg.pools.includes(pool)) continue;
    if (trade.tradeType === 'sell' && cfg.showSells === false) continue;

    const usd = Number(trade.amountUsd || 0);
    if (usd < (cfg.minBuyUsd || 0)) continue;

    if (cfg.activeCompetition) {
      cfg.activeCompetition.leaderboard[trade.buyer || trade.tx] =
        (cfg.activeCompetition.leaderboard[trade.buyer || trade.tx] || 0) + usd;
      await setChat(chatId, cfg);
    }

    const isSell = trade.tradeType === 'sell';
    const emoji = isSell ? '🔴' : tierEmoji(cfg, usd);
    const action = isSell ? 'SELL' : 'BUY';
    const symbol = cfg.tokenSymbols[pool] || 'TOKEN';
    const priceStr = trade.priceUsd ? `$${trade.priceUsd.toFixed(6)}` : '—';
    const amountTok = trade.amountToken ? trade.amountToken.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—';
    const txUrl = EXPLORER_TX_URL + trade.tx;
    const chart = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${pool}`;

    const caption =
      `${emoji} <b>${action}</b> • <b>${escapeHtml(symbol)}</b>\n` +
      `💵 <b>$${usd.toFixed(2)}</b>\n` +
      `🧮 ${amountTok} ${escapeHtml(symbol)} @ ${priceStr}\n` +
      sharedExtraData +
      (trade.buyer ? `👤 ${escapeHtml(trade.buyer.slice(0,6))}…${escapeHtml(trade.buyer.slice(-4))}\n` : '') +
      `🔗 <a href="${txUrl}">TX</a>`;

    const replyMarkup = {
      inline_keyboard: [[{ text: '📈 Chart', url: chart }, { text: '🔎 TX', url: txUrl }]]
    };

    await safeSend(chatId, async () => {
      const usedVideo = await safeSendVideo(chatId, cfg, caption, replyMarkup, cfg.threadId);
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
  if (latest?.id) await broadcastTrade(pool, latest);
}

/**
 * ✅ Backlog guard: if we’re already behind, don’t keep piling work.
 * (Prevents huge queue growth during long 429 periods)
 */
setInterval(() => {
  if (queue.size > 3) return;
  queue.add(tickOnce).catch((e) => {
    console.error('[TICK] failed:', e?.response?.status, e?.response?.data || e.message);
  });
}, Number(POLL_INTERVAL_MS));

console.log('Buy bot started on network:', GECKO_NETWORK);
