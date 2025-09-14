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

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on :' + PORT));

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const memoryStore = new Map();

// ---- State maps ----
const pendingGif = new Map();
const awaitingTokenInput = new Map();
const awaitingMinBuyInput = new Map();
const awaitingTierInput = new Map();
const awaitingRemoveChoice = new Map();
const awaitingDecimalsInput = new Map();
const compWizard = new Map();

// ---- Config helpers ----
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
  if (n >= 100000) return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFraction });
}

function adjustSupply(supplyLike, decimals = 18) {
  if (supplyLike == null) return 0;
  const str = String(supplyLike);
  if (str.includes('.') || str.toLowerCase().includes('e')) return Number(str) || 0;
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    if (!Number.isFinite(n)) return 0;
    return str.length > (Number(decimals) + 2) ? n / Math.pow(10, Number(decimals)) : n;
  }
  return Number(str) || 0;
}

// ---- GeckoTerminal wrappers ----
async function fetchTopPoolForToken(tokenAddr) {
  const url = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
  const { data } = await axios.get(url, { headers: { 'Accept': 'application/json;version=20230302' } });
  const pools = data?.data?.relationships?.top_pools?.data || [];
  if (!pools.length) return null;
  const poolId = pools[0].id;
  const pool = poolId.split('_').pop();
  const symbol = data?.data?.attributes?.symbol || 'TOKEN';
  return { pool, symbol };
}

async function fetchTradesForPool(pool) {
  try {
    const url = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}/trades?limit=5`;
    const { data } = await axios.get(url, { headers: { 'Accept': 'application/json;version=20230302' } });
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
    return {
      id: x.id,
      tx: a.tx_hash,
      priceUsd: Number(a.price_to_in_usd ?? a.price_from_in_usd ?? 0),
      amountUsd: Number(a.volume_in_usd ?? 0),
      amountToken: Number(kind === 'sell' ? a.from_token_amount : a.to_token_amount),
      tradeType: kind,
      buyer: a.tx_from_address || null,
      fromToken: a.from_token_address,
      toToken: a.to_token_address,
      ts: a.block_timestamp
    };
  });
}

// ---- Inline Settings Panel ----
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
  return messageId
    ? bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard })
    : bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ---- Handlers ----
bot.onText(/\/start|\/settings/, (msg) => sendSettingsPanel(msg.chat.id));

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const cfg = await getChat(chatId);
  await bot.answerCallbackQuery(query.id);

  if (query.data === 'show_status') {
    const pools = cfg.pools.length ? cfg.pools.map(p => `<code>${p}</code>`).join('\n') : 'None';
    const statusText =
      `<b>Current Config</b>\n` +
      `Pools:\n${pools}\n\n` +
      `Min Buy: $${cfg.minBuyUsd}\n` +
      `Sells: ${cfg.showSells ? 'ON' : 'OFF'}\n` +
      `Whale Tier: $${cfg.tiers.large}, Mid Tier: $${cfg.tiers.small}\n` +
      `GIF: ${cfg.gifFileId ? '✅ custom set' : (cfg.gifUrl ? cfg.gifUrl : '❌ none')}\n` +
      `${cfg.activeCompetition ? '🏆 Big Buy Comp ACTIVE' : ''}`;
    return bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
  }

  if (query.data === 'close_settings') {
    return bot.deleteMessage(chatId, query.message.message_id);
  }

  if (query.data === 'set_decimals') {
    awaitingDecimalsInput.set(chatId, query.message.message_id);
    return bot.sendMessage(chatId, 'Reply with token address and decimals (e.g. `0x1234... 18`):');
  }
  if (query.data === 'add_token') {
    awaitingTokenInput.set(chatId, query.message.message_id);
    return bot.sendMessage(chatId, 'Reply with token address (0x...) to add:');
  }
  if (query.data === 'remove_token') {
    if (!cfg.pools.length) return bot.sendMessage(chatId, 'No tokens to remove.');
    const rows = cfg.pools.map(p => ([{ text: cfg.tokenSymbols[p] || p, callback_data: `rm:${p}` }]));
    rows.push([{ text: '⬅️ Back', callback_data: 'back_to_settings' }]);
    return bot.editMessageText('Select a token to remove:', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: rows }
    });
  }
  if (query.data === 'back_to_settings') {
    return sendSettingsPanel(chatId, query.message.message_id);
  }
  if (query.data.startsWith('rm:')) {
    const pool = query.data.slice(3);
    cfg.pools = cfg.pools.filter(p => p !== pool);
    delete cfg.tokenSymbols[pool];
    await setChat(chatId, cfg);
    return sendSettingsPanel(chatId, query.message.message_id);
  }
  if (query.data === 'toggle_sells') {
    cfg.showSells = !cfg.showSells;
    await setChat(chatId, cfg);
    return sendSettingsPanel(chatId, query.message.message_id);
  }
  if (query.data === 'set_minbuy') {
    awaitingMinBuyInput.set(chatId, query.message.message_id);
    return bot.sendMessage(chatId, 'Reply with minimum buy amount in USD:');
  }
  if (query.data === 'tier_menu') {
    awaitingTierInput.set(chatId, query.message.message_id);
    return bot.sendMessage(chatId, 'Reply with whale tier and mid tier (e.g. `1000 100`):');
  }
  if (query.data === 'set_gif') {
    pendingGif.set(chatId, query.message.message_id);
    return bot.sendMessage(chatId, 'Reply with a GIF URL or send a GIF:');
  }
  if (query.data === 'start_comp') {
    compWizard.set(chatId, { step: 1, data: {} });
    return bot.sendMessage(chatId, '🏆 Enter duration (minutes):');
  }
  if (query.data === 'show_leaderboard') return postLeaderboard(chatId);
  if (query.data === 'end_comp') {
    if (cfg.activeCompetition) {
      await postLeaderboard(chatId, true);
      cfg.activeCompetition = null;
      await setChat(chatId, cfg);
      return bot.sendMessage(chatId, '🛑 Competition ended.');
    }
    return bot.sendMessage(chatId, 'No active competition.');
  }
});

// ---- Message handlers ----
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (awaitingDecimalsInput.has(chatId)) {
    const msgId = awaitingDecimalsInput.get(chatId);
    awaitingDecimalsInput.delete(chatId);
    const [addr, dec] = msg.text.split(/\s+/);
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr) || isNaN(Number(dec))) {
      await bot.sendMessage(chatId, '❌ Format must be: 0xTOKENADDRESS DECIMALS');
      return sendSettingsPanel(chatId, msgId);
    }
    const cfg = await getChat(chatId);
    cfg.decimalsOverrides[addr.toLowerCase()] = Number(dec);
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, `✅ Decimals for ${addr} set to ${dec}`);
    return sendSettingsPanel(chatId, msgId);
  }

  if (awaitingMinBuyInput.has(chatId)) {
    const msgId = awaitingMinBuyInput.get(chatId);
    awaitingMinBuyInput.delete(chatId);
    const minBuyUsd = Number(msg.text);
    if (isNaN(minBuyUsd) || minBuyUsd < 0) {
      await bot.sendMessage(chatId, '❌ Invalid USD amount.');
      return sendSettingsPanel(chatId, msgId);
    }
    const cfg = await getChat(chatId);
    cfg.minBuyUsd = minBuyUsd;
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, `✅ Minimum buy set to $${minBuyUsd}`);
    return sendSettingsPanel(chatId, msgId);
  }

  if (awaitingTierInput.has(chatId)) {
    const msgId = awaitingTierInput.get(chatId);
    awaitingTierInput.delete(chatId);
    const [large, small] = msg.text.split(/\s+/).map(Number);
    if (isNaN(large) || isNaN(small) || large < small) {
      await bot.sendMessage(chatId, '❌ Invalid tiers. Format: whaleTier midTier (e.g. `1000 100`)');
      return sendSettingsPanel(chatId, msgId);
    }
    const cfg = await getChat(chatId);
    cfg.tiers = { large, small };
    await setChat(chatId, cfg);
    await bot.sendMessage(chatId, `✅ Tiers set: Whale $${large}, Mid $${small}`);
    return sendSettingsPanel(chatId, msgId);
  }

  if (pendingGif.has(chatId)) {
    const msgId = pendingGif.get(chatId);
    pendingGif.delete(chatId);
    const cfg = await getChat(chatId);
    if (msg.animation) {
      cfg.gifFileId = msg.animation.file_id;
      cfg.gifUrl = null;
      await setChat(chatId, cfg);
      await bot.sendMessage(chatId, '✅ Custom GIF set.');
    } else if (msg.text && /^https?:\/\/.*\.(gif|mp4)$/.test(msg.text)) {
      cfg.gifUrl = msg.text;
      cfg.gifFileId = null;
      await setChat(chatId, cfg);
      await bot.sendMessage(chatId, '✅ GIF URL set.');
    } else {
      await bot.sendMessage(chatId, '❌ Please send a GIF or a valid GIF URL.');
    }
    return sendSettingsPanel(chatId, msgId);
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
      return sendSettingsPanel(chatId);
    }
  }
});

// ---- Leaderboard + Competition ----
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

// ---- Auto-End Checker ----
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

// ---- Broadcast + Buy Message ----
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
        const decimals = cfg.decimalsOverrides[tokenAddr.toLowerCase()] ?? tokenAttr.decimals ?? 18;
        const price = Number(trade.priceUsd || tokenAttr.price_usd || 0);

        let mcLabel = 'MC';
        let mcValue = Number(tokenAttr.market_cap_usd ?? 0);
        if (!mcValue && price > 0) {
          const circ = adjustSupply(tokenAttr.circulating_supply, decimals);
          if (circ > 0) mcValue = circ * price;
          else if (tokenAttr.fdv_usd) { mcValue = Number(tokenAttr.fdv_usd); mcLabel = 'FDV'; }
          else {
            const total = adjustSupply(tokenAttr.total_supply, decimals);
            if (total > 0) { mcValue = total * price; mcLabel = 'FDV'; }
          }
        }

        if (mcValue && mcValue > 0) extraData += `📊 ${mcLabel}: $${formatUSD(mcValue)}\n`;
        if (poolAttr.reserve_in_usd) extraData += `💧 Liquidity: $${formatUSD(Number(poolAttr.reserve_in_usd))}\n`;
        if (poolAttr.volume_usd_24h) extraData += `📈 24h Vol: $${formatUSD(Number(poolAttr.volume_usd_24h))}\n`;
        if (tokenAttr.unique_wallet_count) extraData += `👥 Holders: ${tokenAttr.unique_wallet_count}\n`;
      }
    } catch (e) {
      console.warn(`[DEBUG] Extra data fetch failed: ${e.message}`);
    }

    const isSell = trade.tradeType === 'sell';
    const emoji = isSell ? '🔴' : tierEmoji(cfg, usd);
    const caption =
      `${emoji} <b>${isSell ? 'SELL' : 'BUY'}</b> • <b>${escapeHtml(cfg.tokenSymbols[pool] || 'TOKEN')}</b>\n` +
      `💵 <b>$${usd.toFixed(2)}</b>\n` +
      `🧮 ${trade.amountToken?.toLocaleString(undefined,{maximumFractionDigits:6}) || '—'} @ ${price ? `$${price.toFixed(6)}` : '—'}\n` +
      extraData +
      (trade.buyer ? `👤 ${escapeHtml(trade.buyer.slice(0,6))}…${escapeHtml(trade.buyer.slice(-4))}\n` : '') +
      `🔗 <a href="${EXPLORER_TX_URL + trade.tx}">TX</a>`;

    if (cfg.gifFileId) await bot.sendAnimation(chatId, cfg.gifFileId, { caption, parse_mode: 'HTML' });
    else if (cfg.gifUrl) await bot.sendAnimation(chatId, cfg.gifUrl, { caption, parse_mode: 'HTML' });
    else await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
  }
}

// ---- Polling ----
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
  const key = `pool:${pool}:lastTradeId`;
  const last = redis ? await redis.get(key) : memoryStore.get(key);
  if (last === tradeId) return true;
  if (redis) await redis.set(key, tradeId);
  else memoryStore.set(key, tradeId);
  return false;
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
