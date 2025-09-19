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
  POLL_INTERVAL_MS = '400'
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;
const queue = new PQueue({ interval: Number(POLL_INTERVAL_MS), intervalCap: 5 });

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on :' + PORT));

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const memoryStore = new Map();

// State maps for inline flows
const pendingGif = new Map();
const awaitingTokenInput = new Map();
const awaitingMinBuyInput = new Map();
const awaitingTierInput = new Map();
const awaitingRemoveChoice = new Map();
const compWizard = new Map();

// Global error handler to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// -------- Config helpers --------
function defaultChatConfig() {
  return {
    pools: [],
    minBuyUsd: 0,
    gifUrl: null,
    gifFileId: null,
    gifChatId: null,
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
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

// -------- GeckoTerminal wrappers --------
async function fetchTopPoolForToken(tokenAddr) {
  const url = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'Accept': 'application/json;version=20230302' }
    });
    const pools = data?.data?.relationships?.top_pools?.data || [];
    if (!pools.length) return null;
    const poolId = pools[0].id;
    const pool = poolId.split('_').pop(); // Strip network prefix
    const symbol = data?.data?.attributes?.symbol || 'TOKEN';
    return { pool, symbol };
  } catch (e) {
    console.error(`[GeckoTerminal] Failed to fetch top pool for ${tokenAddr}:`, e.message);
    return null;
  }
}

async function fetchTradesForPool(pool) {
  try {
    const url = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}/trades?limit=5`;
    const { data } = await axios.get(url, {
      headers: { 'Accept': 'application/json;version=20230302' }
    });
    return normalizeTrades(data?.data);
  } catch (e) {
    console.error(`[GeckoTerminal] Failed for pool ${pool}:`, e.response?.status, e.response?.data || e.message);
    if (e.response?.status === 404) {
      // Notify chats tracking this pool
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
  const text =
    `⚙️ <b>Settings Panel</b>\n` +
    `<b>Tracking:</b> ${escapeHtml(tokens)}\n` +
    `<b>Min Buy:</b> $${cfg.minBuyUsd}\n` +
    `<b>Whale Tier:</b> $${cfg.tiers.large} | Mid $${cfg.tiers.small}\n` +
    `<b>Sells:</b> ${cfg.showSells ? 'ON' : 'OFF'}\n` +
    `<b>GIF:</b> ${cfg.gifFileId ? '✅ custom' : (cfg.gifUrl ? cfg.gifUrl : '❌ none')}\n` +
    `<b>Competition:</b> ${cfg.activeCompetition ? '🏆 ACTIVE' : '—'}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Add Token', callback_data: 'add_token' },
       { text: '➖ Remove Token', callback_data: 'remove_token' }],
      [{ text: '🎯 Min Buy', callback_data: 'set_minbuy' },
       { text: '🐋 Whale Tier', callback_data: 'tier_menu' }],
      [{ text: cfg.showSells ? '🔴 Hide Sells' : '🟢 Show Sells', callback_data: 'toggle_sells' }],
      [
        { text: '🎞 Set GIF', callback_data: 'set_gif' },
        { text: '🗑 Remove GIF', callback_data: 'remove_gif' }
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
      console.warn(`[WARN] Could not edit/send settings panel for chat ${chatId} (invalid message or thread). Sending new message.`);
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

bot.onText(/\/removegif/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  cfg.gifFileId = null;
  cfg.gifUrl = null;
  cfg.gifChatId = null;
  await setChat(chatId, cfg);
  await bot.sendMessage(chatId, '🗑 GIF removed. Alerts will use text only.', { ...opts });
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

    case 'set_gif':
      pendingGif.set(chatId, true);
      await bot.sendMessage(chatId, '📎 Send the GIF/animation you want to use for alerts (as an animation).', { ...opts });
      break;

    case 'remove_gif':
      cfg.gifFileId = null;
      cfg.gifUrl = null;
      cfg.gifChatId = null;
      await setChat(chatId, cfg);
      await bot.answerCallbackQuery(query.id, { text: 'GIF removed.' });
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

// -------- Message handlers --------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };

  if (msg.text && msg.text.startsWith('/')) {
    return;
  }

  if (msg.animation && pendingGif.has(chatId)) {
    cfg.gifFileId = msg.animation.file_id;
    cfg.gifUrl = null;
    cfg.gifChatId = chatId;
    await setChat(chatId, cfg);
    pendingGif.delete(chatId);
    await bot.sendMessage(chatId, '✅ GIF saved! Will play on every buy alert in this chat.', { ...opts });
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

// -------- Backward-compatible commands --------
bot.onText(/\/add (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  const token = match[1];
  const top = await fetchTopPoolForToken(token);
  if (!top) return bot.sendMessage(chatId, '❌ No pool found for that token on this network.', { ...opts });
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

bot.onText(/\/setgif(?: (https?:\/\/\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  if (match[1]) {
    cfg.gifUrl = match[1];
    cfg.gifFileId = null;
    cfg.gifChatId = null;
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, '✅ GIF URL set.', { ...opts });
  } else {
    pendingGif.set(chatId, true);
    await bot.sendMessage(chatId, '📎 Send the GIF/animation you want to use for alerts.', { ...opts });
  }
});

bot.on('animation', async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };
  if (!pendingGif.get(chatId)) return;
  cfg.gifFileId = msg.animation.file_id;
  cfg.gifUrl = null;
  cfg.gifChatId = chatId;
  await setChat(chatId, cfg);
  pendingGif.delete(chatId);
  await bot.sendMessage(chatId, '✅ GIF saved! Will play on every buy alert in this chat.', { ...opts });
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
  const statusText =
    `<b>Current Config</b>\n` +
    `Pools:\n${pools}\n\n` +
    `Min Buy: $${cfg.minBuyUsd}\n` +
    `Sells: ${cfg.showSells ? 'ON' : 'OFF'}\n` +
    `Whale Tier: $${cfg.tiers.large}, Mid Tier: $${cfg.tiers.small}\n` +
    `GIF: ${cfg.gifFileId ? `✅ custom set (chat ${cfg.gifChatId})` : (cfg.gifUrl ? cfg.gifUrl : '❌ none')}\n` +
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
  const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
  const set = new Set();
  for (const k of keys) {
    const chatId = Number(k.split(':')[1]);
    const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
    (cfg?.pools || []).forEach(p => set.add(p));
  }
  poolRoundRobin = Array.from(set);
}
setInterval(refreshPoolSet, 10000);
refreshPoolSet();

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
      console.log(`[INFO] Chat ${chatId} is invalid (kicked, forbidden, or upgraded to supergroup). Cleaning config.`);
      if (redis) await redis.del(`chat:${chatId}:config`);
      else memoryStore.delete(chatId);
      try {
        await bot.sendMessage(chatId, '⚠️ Chat was upgraded to a supergroup or the bot was removed. Please run /settings to reconfigure.', {});
      } catch (notifyErr) {
        console.warn(`[WARN] Could not notify chat ${chatId} about upgrade:`, notifyErr.message);
      }
    } else if (desc.includes('file_id') || desc.includes('not found') || desc.includes('message thread not found')) {
      console.warn(`[WARN] Invalid operation for chat ${chatId} (GIF file_id or thread not found). Falling back.`);
      const cfg = await getChat(chatId);
      if (desc.includes('message thread not found')) {
        cfg.threadId = null;
        await setChat(chatId, cfg);
        console.log(`[INFO] Cleared threadId for chat ${chatId} due to invalid topic`);
        try {
          await bot.sendMessage(chatId, '⚠️ Topic not found. Thread ID cleared. Please run /settings in a valid topic.', {});
        } catch (notifyErr) {
          console.warn(`[WARN] Could not notify chat ${chatId} about invalid topic:`, notifyErr.message);
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

    const usd = Number(trade.amountUsd || 0);
    if (usd < (cfg.minBuyUsd || 0)) continue;

    if (cfg.activeCompetition) {
      cfg.activeCompetition.leaderboard[trade.buyer || trade.tx] =
        (cfg.activeCompetition.leaderboard[trade.buyer || trade.tx] || 0) + usd;
      await setChat(chatId, cfg);
    }

    let extraData = '';
    try {
      const tokenAddr = trade.toToken || trade.fromToken;
      if (tokenAddr) {
        const tokenUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
        const poolUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}`;
        const [tokenRes, poolRes] = await Promise.all([
          axios.get(tokenUrl, { headers: { 'Accept': 'application/json;version=20230302' } }),
          axios.get(poolUrl, { headers: { 'Accept': 'application/json;version=20230302' } })
        ]);

        const tokenAttr = tokenRes?.data?.data?.attributes || {};
        const poolAttr = poolRes?.data?.data?.attributes || {};
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
        if (tokenAttr.unique_wallet_count) {
          extraData += `👥 Holders: ${tokenAttr.unique_wallet_count}\n`;
        }
      }
    } catch (e) {
      console.warn(`[DEBUG] Extra data fetch failed:`, e.message);
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
      extraData +
      (trade.buyer ? `👤 ${escapeHtml(trade.buyer.slice(0,6))}…${escapeHtml(trade.buyer.slice(-4))}\n` : '') +
      `🔗 <a href="${txUrl}">TX</a>`;

    await safeSend(chatId, async (opts) => {
      if (cfg.gifFileId && cfg.gifChatId === chatId) {
        await bot.sendAnimation(chatId, cfg.gifFileId, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          message_thread_id: cfg.threadId || undefined,
          caption,
          reply_markup: { inline_keyboard: [[{ text: '📈 Chart', url: chart }, { text: '🔎 TX', url: txUrl }]] }
        });
      } else if (cfg.gifUrl) {
        await bot.sendAnimation(chatId, cfg.gifUrl, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          message_thread_id: cfg.threadId || undefined,
          caption,
          reply_markup: { inline_keyboard: [[{ text: '📈 Chart', url: chart }, { text: '🔎 TX', url: txUrl }]] }
        });
      } else {
        await bot.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          message_thread_id: cfg.threadId || undefined,
          reply_markup: { inline_keyboard: [[{ text: '📈 Chart', url: chart }, { text: '🔎 TX', url: txUrl }]] }
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

setInterval(() => queue.add(tickOnce).catch(console.error), Number(POLL_INTERVAL_MS));
console.log('Buy bot started on network:', GECKO_NETWORK);
