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
  POLL_INTERVAL_MS = '2000'
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;
const queue = new PQueue({ interval: Number(POLL_INTERVAL_MS), intervalCap: 1 });

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on :' + PORT));

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const memoryStore = new Map();

// State maps
const pendingGif = new Map();
const awaitingTokenInput = new Map();
const awaitingMinBuyInput = new Map();
const awaitingTierInput = new Map();
const awaitingRemoveChoice = new Map();
const awaitingDecimalsInput = new Map();
const compWizard = new Map();

// -------- Config helpers --------
function defaultChatConfig() {
  return {
    pools: [],
    minBuyUsd: 0,
    gifUrl: null,
    gifFileId: null,
    emoji: { small: '🟢', mid: '💎', large: '🐋' },
    tiers: { small: 100, large: 1000 },
    tokenSymbols: {},
    decimalsOverrides: {},
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
    const pool = poolId.split('_').pop();
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
    };
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
      [{ text: '🔢 Set Decimals', callback_data: 'set_decimals' }],
      [{ text: cfg.showSells ? '🔴 Hide Sells' : '🟢 Show Sells', callback_data: 'toggle_sells' }],
      [{ text: '🎞 Set GIF', callback_data: 'set_gif' }],
      [{ text: '🏆 Start Competition', callback_data: 'start_comp' },
       { text: '📊 Leaderboard', callback_data: 'show_leaderboard' },
       { text: '🛑 End Competition', callback_data: 'end_comp' }],
      [{ text: '📊 Status', callback_data: 'show_status' }],
      [{ text: '✅ Done', callback_data: 'close_settings' }]
    ]
  };

  if (messageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// -------- Handlers --------
bot.onText(/\/settings|\/start/, (msg) => sendSettingsPanel(msg.chat.id));

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const cfg = await getChat(chatId);
  await bot.answerCallbackQuery(query.id);

  switch (query.data) {
    case 'add_token':
      awaitingTokenInput.set(chatId, query.message.message_id);
      await bot.sendMessage(chatId, 'Reply with token address (0x...) to add:');
      break;

    case 'remove_token':
      if (!cfg.pools.length) {
        await bot.sendMessage(chatId, 'No tokens to remove.');
        return;
      }
      const rows = cfg.pools.map(p => ([{ text: (cfg.tokenSymbols[p] || p.slice(0,6)+'…'+p.slice(-4)), callback_data: `rm:${p}` }]));
      rows.push([{ text: '⬅️ Back', callback_data: 'back_to_settings' }]);
      await bot.editMessageText('Select a token to remove:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: rows }
      });
      awaitingRemoveChoice.set(chatId, query.message.message_id);
      break;

    case 'close_settings':
      return bot.deleteMessage(chatId, query.message.message_id);

    case 'set_minbuy':
      awaitingMinBuyInput.set(chatId, query.message.message_id);
      await bot.sendMessage(chatId, 'Reply with minimum buy USD value (e.g. 50):');
      break;

    case 'tier_menu':
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
          }
        }
      );
      break;

    case 'set_tier_small':
      awaitingTierInput.set(chatId, { which: 'small', msg: query.message.message_id });
      await bot.sendMessage(chatId, 'Reply with new SMALL tier value (USD):');
      break;

    case 'set_tier_large':
      awaitingTierInput.set(chatId, { which: 'large', msg: query.message.message_id });
      await bot.sendMessage(chatId, 'Reply with new LARGE tier value (USD):');
      break;

    case 'set_decimals':
      awaitingDecimalsInput.set(chatId, query.message.message_id);
      await bot.sendMessage(chatId, 'Reply with token address and decimals (e.g. `0x1234... 18`):');
      break;

    case 'toggle_sells':
      cfg.showSells = !cfg.showSells;
      await setChat(chatId, cfg);
      await bot.answerCallbackQuery(query.id, { text: `Sell alerts ${cfg.showSells ? 'ON' : 'OFF'}` });
      await sendSettingsPanel(chatId, query.message.message_id);
      break;

    case 'set_gif':
      pendingGif.set(chatId, true);
      await bot.sendMessage(chatId, '📎 Send the GIF/animation you want to use for alerts (as an animation).');
      break;

    case 'show_status':
      await bot.sendMessage(chatId, 'Use /status to view full configuration.');
      break;

    case 'back_to_settings':
      await sendSettingsPanel(chatId, query.message.message_id);
      break;

    case 'start_comp':
      compWizard.set(chatId, { step: 1, data: {} });
      await bot.sendMessage(chatId, '🏆 Enter duration (minutes):');
      break;

    case 'show_leaderboard':
      await postLeaderboard(chatId);
      break;

    case 'end_comp':
      if (cfg.activeCompetition) {
        await postLeaderboard(chatId, true);
        cfg.activeCompetition = null;
        await setChat(chatId, cfg);
        await bot.sendMessage(chatId, '🛑 Competition ended.');
      } else {
        await bot.sendMessage(chatId, 'No active competition.');
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

  if (msg.animation) {
    if (!pendingGif.get(chatId)) return;
    const cfg = await getChat(chatId);
    cfg.gifFileId = msg.animation.file_id;
    cfg.gifUrl = null;
    await setChat(chatId, cfg);
    pendingGif.delete(chatId);
    await bot.sendMessage(chatId, '✅ GIF saved! Will play on every buy alert.');
    await sendSettingsPanel(chatId);
    return;
  }

  if (!msg.text) return;

  if (awaitingTokenInput.has(chatId)) {
    const token = msg.text.trim();
    const isAddr = /^0x[a-fA-F0-9]{40}$/.test(token);
    const msgId = awaitingTokenInput.get(chatId);
    awaitingTokenInput.delete(chatId);
    if (!isAddr) {
      await bot.sendMessage(chatId, '❌ Invalid address. Please send a valid 0x token address.');
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    const top = await fetchTopPoolForToken(token);
    if (top) {
      const cfg = await getChat(chatId);
      if (!cfg.pools.includes(top.pool)) cfg.pools.push(top.pool);
      cfg.tokenSymbols[top.pool] = top.symbol || 'TOKEN';
      await setChat(chatId, cfg);
      await bot.sendMessage(chatId, `✅ Tracking ${top.symbol} (${top.pool.slice(0,6)}…${top.pool.slice(-4)})`);
      await sendSettingsPanel(chatId, msgId);
    } else {
      await bot.sendMessage(chatId, '❌ No pool found for that token on this network.');
      await sendSettingsPanel(chatId, msgId);
    }
    return;
  }

  if (awaitingMinBuyInput.has(chatId)) {
    const val = Number(msg.text);
    const msgId = awaitingMinBuyInput.get(chatId);
    awaitingMinBuyInput.delete(chatId);
    if (!Number.isFinite(val) || val < 0) {
      await bot.sendMessage(chatId, '❌ Please enter a valid non-negative number.');
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    const cfg = await getChat(chatId);
    cfg.minBuyUsd = val;
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, `✅ Min buy set to $${val}`);
    await sendSettingsPanel(chatId, msgId);
    return;
  }

  if (awaitingTierInput.has(chatId)) {
    const { which, msg: msgId } = awaitingTierInput.get(chatId);
    awaitingTierInput.delete(chatId);
    const val = Number(msg.text);
    if (!Number.isFinite(val) || val < 0) {
      await bot.sendMessage(chatId, '❌ Please enter a valid non-negative number.');
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    const cfg = await getChat(chatId);
    cfg.tiers[which] = val;
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, `✅ ${which.toUpperCase()} tier set to $${val}`);
    await sendSettingsPanel(chatId, msgId);
    return;
  }

  if (awaitingDecimalsInput.has(chatId)) {
    const msgId = awaitingDecimalsInput.get(chatId);
    awaitingDecimalsInput.delete(chatId);
    const [addr, dec] = msg.text.split(/\s+/);
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr) || isNaN(Number(dec))) {
      await bot.sendMessage(chatId, '❌ Format must be: 0xTOKENADDRESS DECIMALS');
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    const cfg = await getChat(chatId);
    cfg.decimalsOverrides[addr.toLowerCase()] = Number(dec);
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, `✅ Decimals for ${addr} set to ${dec}`);
    await sendSettingsPanel(chatId, msgId);
    return;
  }

  const wizard = compWizard.get(chatId);
  if (wizard) {
    const data = wizard.data;
    if (wizard.step === 1) {
      const minutes = Number(msg.text);
      if (!minutes || minutes < 1) return bot.sendMessage(chatId, 'Enter a valid duration in minutes:');
      data.duration = minutes;
      wizard.step = 2;
      return bot.sendMessage(chatId, 'Enter minimum buy USD to qualify:');
    }
    if (wizard.step === 2) {
      data.minBuyUsd = Number(msg.text) || 0;
      wizard.step = 3;
      return bot.sendMessage(chatId, 'Enter prize for 🥇 1st place:');
    }
    if (wizard.step === 3) {
      data.prize1 = msg.text;
      wizard.step = 4;
      return bot.sendMessage(chatId, 'Enter prizes for 🥈 2nd and 🥉 3rd (comma separated):');
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
        `🥇 ${data.prizes[0]}\n🥈 ${data.prizes[1]}\n🥉 ${data.prizes[2]}`);
      await sendSettingsPanel(chatId);
      return;
    }
  }
});

// -------- Backward-compatible commands --------
bot.onText(/\/add (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1];
  const top = await fetchTopPoolForToken(token);
  if (!top) return bot.sendMessage(chatId, '❌ No pool found for that token on this network.');
  const cfg = await getChat(chatId);
  if (!cfg.pools.includes(top.pool)) cfg.pools.push(top.pool);
  cfg.tokenSymbols[top.pool] = top.symbol || 'TOKEN';
  await setChat(chatId, cfg);
  const chart = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${top.pool}`;
  bot.sendMessage(chatId, `✅ Tracking <b>${escapeHtml(top.symbol)}</b>\nPool: <code>${top.pool}</code>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '📈 Chart', url: chart }]] }
  });
});

bot.onText(/\/remove (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1];
  const top = await fetchTopPoolForToken(token);
  if (!top) return bot.sendMessage(chatId, '❌ Could not resolve a pool for that token.');
  const cfg = await getChat(chatId);
  cfg.pools = cfg.pools.filter(p => p !== top.pool);
  delete cfg.tokenSymbols[top.pool];
  await setChat(chatId, cfg);
  bot.sendMessage(chatId, `🛑 Stopped tracking pool ${top.pool}`);
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  if (!cfg.pools.length) return bot.sendMessage(chatId, 'No pools yet. Add with /add 0xYourToken or use /settings → Add Token');
  const lines = cfg.pools.map(p => `• <code>${p}</code> (${escapeHtml(cfg.tokenSymbols[p] || 'TOKEN')})`);
  bot.sendMessage(chatId, `<b>Tracking:</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
});

bot.onText(/\/minbuy (\d+(\.\d+)?)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const min = Number(match[1]);
  const cfg = await getChat(chatId);
  cfg.minBuyUsd = min;
  await setChat(chatId, cfg);
  bot.sendMessage(chatId, `✅ Minimum buy set to $${min}`);
});

bot.onText(/\/setgif(?: (https?:\/\/\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (match[1]) {
    const cfg = await getChat(chatId);
    cfg.gifUrl = match[1];
    cfg.gifFileId = null;
    await setChat(chatId, cfg);
    bot.sendMessage(chatId, '✅ GIF URL set.');
  } else {
    pendingGif.set(chatId, true);
    bot.sendMessage(chatId, '📎 Send the GIF/animation you want to use for alerts.');
  }
});

bot.on('animation', async (msg) => {
  const chatId = msg.chat.id;
  if (!pendingGif.get(chatId)) return;
  const cfg = await getChat(chatId);
  cfg.gifFileId = msg.animation.file_id;
  cfg.gifUrl = null;
  await setChat(chatId, cfg);
  pendingGif.delete(chatId);
  bot.sendMessage(chatId, '✅ GIF saved! Will play on every buy alert.');
});

bot.onText(/\/emoji (small|mid|large) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const which = match[1];
  const value = match[2];
  const cfg = await getChat(chatId);
  cfg.emoji[which] = value;
  await setChat(chatId, cfg);
  bot.sendMessage(chatId, `✅ ${which} emoji → ${value}`);
});

bot.onText(/\/tier (small|large) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const which = match[1];
  const value = Number(match[2]);
  const cfg = await getChat(chatId);
  cfg.tiers[which] = value;
  await setChat(chatId, cfg);
  bot.sendMessage(chatId, `✅ ${which} buy threshold set to $${value}`);
});

bot.onText(/\/showsells (on|off)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const value = match[1].toLowerCase() === 'on';
  const cfg = await getChat(chatId);
  cfg.showSells = value;
  await setChat(chatId, cfg);
  bot.sendMessage(chatId, `✅ Sell alerts are now ${value ? 'ON' : 'OFF'}`);
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const pools = cfg.pools.length ? cfg.pools.map(p => `<code>${p}</code>`).join('\n') : 'None';
  const statusText =
    `<b>Current Config</b>\n` +
    `Pools:\n${pools}\n\n` +
    `Min Buy: $${cfg.minBuyUsd}\n` +
    `Sells: ${cfg.showSells ? 'ON' : 'OFF'}\n` +
    `Whale Tier: $${cfg.tiers.large}, Mid Tier: $${cfg.tiers.small}\n` +
    `GIF: ${cfg.gifFileId ? '✅ custom set' : (cfg.gifUrl ? cfg.gifUrl : '❌ none')}\n` +
    `${cfg.activeCompetition ? '🏆 Big Buy Comp ACTIVE' : ''}`;
  bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
});

bot.onText(/\/ping/, (msg) => bot.sendMessage(msg.chat.id, '✅ Bot is online and running.'));

// -------- Leaderboard + Competition --------
async function postLeaderboard(chatId, final = false) {
  const cfg = await getChat(chatId);
  if (!cfg.activeCompetition) return;
  const lb = Object.entries(cfg.activeCompetition.leaderboard || {}).sort((a,b) => b[1] - a[1]);
  if (!lb.length) return bot.sendMessage(chatId, final ? 'No qualifying buys. Competition ended.' : 'No entries yet.');
  let msg = final ? '🎉 <b>Big Buy Competition Over!</b>\n\n' : '📊 <b>Current Leaderboard</b>\n\n';
  lb.slice(0, 10).forEach(([wallet, amount], i) => {
    msg += `${['🥇','🥈','🥉'][i] || (i+1)+'.'} ${wallet.slice(0,6)}…${wallet.slice(-4)} — $${amount.toFixed(2)}\n`;
  });
  if (final && cfg.activeCompetition.prizes?.length) {
    msg += `\n🏆 Prizes:\n🥇 ${cfg.activeCompetition.prizes[0] || '-'}\n🥈 ${cfg.activeCompetition.prizes[1] || '-'}\n🥉 ${cfg.activeCompetition.prizes[2] || '-'}`;
  }
  await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
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
    const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(Number(k.split(':')[1]));
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
    await sendFn();
  } catch (e) {
    if (e.response?.body?.description?.includes('kicked') ||
        e.response?.body?.description?.includes('forbidden')) {
      console.log(`[INFO] Bot removed from chat ${chatId}, cleaning config`);
      if (redis) await redis.del(`chat:${chatId}:config`);
      else memoryStore.delete(chatId);
    } else {
      console.error(`[ERROR] Telegram send failed for chat ${chatId}:`, e.message);
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
    let price = Number(trade.priceUsd || 0);
    try {
      const tokenAddr = trade.toToken || trade.fromToken;
      let tokenAttr = {};
      let poolAttr = {};
      if (tokenAddr) {
        const tokenUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
        const poolUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}`;
        const [tokenRes, poolRes] = await Promise.all([
          axios.get(tokenUrl, { headers: { 'Accept': 'application/json;version=20230302' } }).catch(() => ({})),
          axios.get(poolUrl, { headers: { 'Accept': 'application/json;version=20230302' } }).catch(() => ({}))
        ]);
        tokenAttr = tokenRes?.data?.data?.attributes || {};
        poolAttr = poolRes?.data?.data?.attributes || {};
      }

      const decimals = cfg.decimalsOverrides[tokenAddr?.toLowerCase()] ?? tokenAttr.decimals ?? 18;
      price = Number(trade.priceUsd || tokenAttr.price_usd || 0);

      let mcLabel = 'MC';
      let mcValue = Number(tokenAttr.market_cap_usd ?? 0);
      if (!mcValue && price > 0) {
        const circ = adjustSupply(tokenAttr.circulating_supply, decimals);
        if (circ > 0) mcValue = circ * price;
        else if (tokenAttr.fdv_usd) {
          mcValue = Number(tokenAttr.fdv_usd);
          mcLabel = 'FDV';
        } else {
          const total = adjustSupply(tokenAttr.total_supply, decimals);
          if (total > 0) {
            mcValue = total * price;
            mcLabel = 'FDV';
          }
        }
      }

      extraData += `📊 ${mcLabel}: ${mcValue > 0 ? '$' + formatUSD(mcValue) : '—'}\n`;
      extraData += `💧 Liquidity: ${poolAttr.reserve_in_usd ? '$' + formatUSD(Number(poolAttr.reserve_in_usd)) : '—'}\n`;
      if (poolAttr.volume_usd_24h) extraData += `📈 24h Vol: $${formatUSD(Number(poolAttr.volume_usd_24h))}\n`;
      if (tokenAttr.price_percent_change_24h != null) {
        const pct = Number(tokenAttr.price_percent_change_24h);
        if (Number.isFinite(pct)) extraData += `📊 24h Change: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%\n`;
      }
      if (tokenAttr.unique_wallet_count) {
        extraData += `👥 Holders: ${tokenAttr.unique_wallet_count}\n`;
      }
    } catch (e) {
      console.warn(`[DEBUG] Extra data fetch failed:`, e.message);
      extraData += `📊 MC: —\n💧 Liquidity: —\n`;
    }

    const isSell = trade.tradeType === 'sell';
    const emoji = isSell ? '🔴' : tierEmoji(cfg, usd);
    const action = isSell ? 'SELL' : 'BUY';
    const symbol = cfg.tokenSymbols[pool] || 'TOKEN';
    const priceStr = price ? `$${price.toFixed(6)}` : '—';
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

    await safeSend(chatId, async () => {
      if (cfg.gifFileId) {
        await bot.sendAnimation(chatId, cfg.gifFileId, {
          caption, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '📈 Chart', url: chart }, { text: '🔎 TX', url: txUrl }]] }
        });
      } else if (cfg.gifUrl) {
        await bot.sendAnimation(chatId, cfg.gifUrl, {
          caption, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '📈 Chart', url: chart }, { text: '🔎 TX', url: txUrl }]] }
        });
      } else {
        await bot.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
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
