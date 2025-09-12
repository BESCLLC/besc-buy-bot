import 'dotenv/config';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Redis from 'ioredis';
import PQueue from 'p-queue';

// ---------- Config ----------
const {
  TELEGRAM_TOKEN,
  GECKO_NETWORK = 'besc-hyperchain',
  EXPLORER_TX_URL = 'https://explorer.beschyperchain.com/tx/',
  REDIS_URL,
  POLL_INTERVAL_MS = '2000',
  USE_COINGECKO_ONCHAIN = 'false',
  COINGECKO_API_KEY
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

// Health HTTP server so Railway keeps us alive
const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on :' + PORT));

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const CG_BASE = 'https://pro-api.coingecko.com/api/v3/onchain';

const memoryStore = new Map();

function defaultChatConfig() {
  return {
    pools: [],
    minBuyUsd: 0,
    gifUrl: null,
    emoji: { small: '🟢', mid: '💎', large: '🐋' },
    tiers: { small: 100, large: 1000 },
    tokenSymbols: {}
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

// ---------- API Wrappers ----------
async function fetchTopPoolForToken(tokenAddr) {
  const url = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
  const { data } = await axios.get(url, {
    headers: { 'Accept': 'application/json;version=20230302' }
  });
  const pools = data?.data?.relationships?.top_pools?.data || [];
  if (!pools.length) return null;
  const poolId = pools[0].id;
  const pool = poolId.split('_').pop();
  const symbol = data?.data?.attributes?.symbol || 'TOKEN';
  return { pool, symbol };
}

async function fetchTradesForPool(pool) {
  try {
    if (USE_COINGECKO_ONCHAIN === 'true' && COINGECKO_API_KEY) {
      const url = `${CG_BASE}/networks/${GECKO_NETWORK}/pools/${pool}/trades?limit=5`;
      const { data } = await axios.get(url, {
        headers: {
          'x-cg-pro-api-key': COINGECKO_API_KEY,
          'Accept': 'application/json;version=20230302'
        }
      });
      return normalizeTrades(data?.data);
    } else {
      const url = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}/trades?limit=5`;
      const { data } = await axios.get(url, {
        headers: { 'Accept': 'application/json;version=20230302' }
      });
      return normalizeTrades(data?.data);
    }
  } catch (e) {
    console.error(`[GeckoTerminal] Failed for pool ${pool}:`, e.response?.status, e.response?.data || e.message);
    return [];
  }
}

function normalizeTrades(items) {
  return (items || []).map(x => {
    const a = x.attributes || {};
    const priceUsd = Number(a.price_usd ?? 0);
    const amountUsd = Number(a.amount_usd ?? 0);
    return {
      id: x.id,
      tx: a.tx_hash,
      priceUsd,
      amountUsd,
      amountToken: Number(a.amount_token ?? 0),
      tradeType: (a.trade_type || '').toLowerCase(),
      direction: a.direction || null,
      buyer: a.trader_address || null,
      ts: a.block_timestamp || a.timestamp,
      needsPrice: (!priceUsd || !amountUsd)
    };
  });
}

// ---------- Telegram Commands ----------
bot.onText(/\/add (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1];
  try {
    await bot.sendChatAction(chatId, 'typing');
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
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '⚠️ Error looking up token. Make sure it trades on this network.');
  }
});

bot.onText(/\/remove (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1];
  try {
    const top = await fetchTopPoolForToken(token);
    if (!top) return bot.sendMessage(chatId, '❌ Could not resolve a pool for that token.');
    const cfg = await getChat(chatId);
    cfg.pools = cfg.pools.filter(p => p !== top.pool);
    delete cfg.tokenSymbols[top.pool];
    await setChat(chatId, cfg);
    bot.sendMessage(chatId, `🛑 Stopped tracking pool ${top.pool}`);
  } catch {
    bot.sendMessage(chatId, '⚠️ Error removing.');
  }
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  if (!cfg.pools.length) return bot.sendMessage(chatId, 'No pools here yet. Add with /add 0xYourToken');
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

bot.onText(/\/setgif (https?:\/\/\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  cfg.gifUrl = match[1];
  await setChat(chatId, cfg);
  bot.sendMessage(chatId, `✅ GIF set.`);
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

// ---------- Poller ----------
const queue = new PQueue({ interval: Number(POLL_INTERVAL_MS), intervalCap: 1 });
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

async function broadcastTrade(pool, trade) {
  const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
  for (const k of keys) {
    const chatId = Number(k.split(':')[1]);
    const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
    if (!cfg.pools.includes(pool)) continue;

    const usd = Number(trade.amountUsd || 0);
    if (usd < (cfg.minBuyUsd || 0)) continue;

    const isSell = trade.tradeType === 'sell' || trade.direction === 'out';
    const emoji = isSell ? '🔴' : tierEmoji(cfg, usd);
    const action = isSell ? 'SELL' : 'BUY';

    const symbol = cfg.tokenSymbols[pool] || 'TOKEN';
    const price = trade.priceUsd ? `$${trade.priceUsd.toFixed(6)}` : '—';
    const amountTok = trade.amountToken ? trade.amountToken.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—';
    const txUrl = EXPLORER_TX_URL + trade.tx;
    const chart = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${pool}`;

    const caption = `${emoji} <b>${action}</b> • <b>${escapeHtml(symbol)}</b>\n` +
      `💵 <b>$${usd.toFixed(2)}</b>\n` +
      `🧮 ${amountTok} ${escapeHtml(symbol)} @ ${price}\n` +
      (trade.buyer ? `👤 ${escapeHtml(trade.buyer.slice(0,6))}…${escapeHtml(trade.buyer.slice(-4))}\n` : '') +
      `🔗 <a href="${txUrl}">TX</a>`;

    const markup = {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '📈 Chart', url: chart },
          { text: '🔎 TX', url: txUrl }
        ]]
      }
    };

    if (cfg.gifUrl) {
      await bot.sendAnimation(chatId, cfg.gifUrl, { caption, ...markup });
    } else {
      await bot.sendMessage(chatId, caption, markup);
    }
  }
}

async function tickOnce() {
  if (!poolRoundRobin.length) return;
  const pool = poolRoundRobin.shift();
  poolRoundRobin.push(pool);

  let trades = await fetchTradesForPool(pool);
  if (!trades.length) return;

  if (trades[0].needsPrice) {
    try {
      const poolUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}`;
      const poolRes = await axios.get(poolUrl, {
        headers: { 'Accept': 'application/json;version=20230302' }
      });

      let price = Number(poolRes?.data?.data?.attributes?.price_in_usd ?? 0);

      if (!price || price === 0) {
        const baseToken = poolRes?.data?.data?.attributes?.base_token_address;
        if (baseToken) {
          const tokenPriceUrl = `${GT_BASE}/simple/networks/${GECKO_NETWORK}/token_price/${baseToken}`;
          const priceRes = await axios.get(tokenPriceUrl, {
            headers: { 'Accept': 'application/json;version=20230302' }
          });
          price = Number(priceRes?.data?.attributes?.price_usd ?? 0);
        }
      }

      if (price > 0) {
        trades = trades.map(t => ({
          ...t,
          priceUsd: price,
          amountUsd: price * t.amountToken
        }));
      }
    } catch (e) {
      console.warn(`[DEBUG] Could not fetch price for pool ${pool}`, e.message);
    }
  }

  console.log(`[DEBUG] Pool ${pool} returned ${trades.length} trades, latest USD: $${trades[0].amountUsd}`);

  const latest = trades[0];
  if (latest?.id && await seen(pool, latest.id)) return;
  if (latest?.id) await broadcastTrade(pool, latest);
}

setInterval(() => queue.add(tickOnce).catch(console.error), Number(POLL_INTERVAL_MS));
console.log('Buy bot started on network:', GECKO_NETWORK);
