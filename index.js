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
  REDIS_URL, // set by Railway Redis addon
  POLL_INTERVAL_MS = '2000', // 2s per request (<=30/min)
  USE_COINGECKO_ONCHAIN = 'false', // set "true" with COINGECKO_API_KEY to upgrade
  COINGECKO_API_KEY
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = new Redis(REDIS_URL);

// Health HTTP server so Railway keeps us alive
const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on :' + PORT));

// ---------- Helpers ----------
const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const CG_BASE = 'https://pro-api.coingecko.com/api/v3/onchain'; // paid upgrade

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// store chat config in Redis per chat
async function getChat(chatId) {
  const raw = await redis.get(`chat:${chatId}:config`);
  if (raw) return JSON.parse(raw);
  const cfg = {
    pools: [],                // array of pool addresses (0x..)
    minBuyUsd: 0,
    gifUrl: null,
    emoji: { small: '🟢', mid: '💎', large: '🐋' },
    tiers: { small: 100, large: 1000 }, // <100 small, <1000 mid, >=1000 large
    tokenSymbols: {}          // pool->symbol
  };
  await redis.set(`chat:${chatId}:config`, JSON.stringify(cfg));
  return cfg;
}
async function setChat(chatId, cfg) {
  await redis.set(`chat:${chatId}:config`, JSON.stringify(cfg));
}

function tierEmoji(cfg, usd) {
  if (usd >= cfg.tiers.large) return cfg.emoji.large;
  if (usd >= cfg.tiers.small) return cfg.emoji.mid;
  return cfg.emoji.small;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------- GeckoTerminal + CoinGecko wrappers ----------
async function fetchTopPoolForToken(tokenAddr) {
  // GET /networks/{network}/tokens/{token}
  // Parse relationships.top_pools to pick first pool id → "..._{0xPool}"
  // Public, keyless. Docs: apiguide + Swagger. 
  const url = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
  const { data } = await axios.get(url);
  const pools = data?.data?.relationships?.top_pools?.data || [];
  if (!pools.length) return null;
  const poolId = pools[0].id;               // e.g., "besc-hyperchain_0xABC..."
  const pool = poolId.split('_').pop();
  // Try symbol
  const symbol = data?.data?.attributes?.symbol || 'TOKEN';
  return { pool, symbol };
}

async function fetchTradesForPool(pool) {
  // Prefer CoinGecko /onchain trades (paid), else GeckoTerminal swaps (free)
  if (USE_COINGECKO_ONCHAIN === 'true' && COINGECKO_API_KEY) {
    const url = `${CG_BASE}/networks/${GECKO_NETWORK}/pools/${pool}/trades?limit=5`;
    const { data } = await axios.get(url, {
      headers: { 'x-cg-pro-api-key': COINGECKO_API_KEY }
    });
    // Standardize items
    const items = (data?.data || []).map(x => {
      const a = x.attributes || {};
      return {
        tx: a.tx_hash,
        priceUsd: Number(a.price_usd),
        amountUsd: Number(a.amount_usd),
        amountToken: Number(a.amount_token),
        tradeType: (a.trade_type || '').toLowerCase(), // "buy" | "sell"
        buyer: a.trader_address || null,
        ts: a.block_timestamp
      };
    });
    return items;
  } else {
    // Free public: /pools/{pool}/swaps?limit=5 (fields vary, but include tx hash & usd)
    const url = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}/swaps?limit=5`;
    const { data } = await axios.get(url);
    const items = (data?.data || []).map(x => {
      const a = x.attributes || {};
      return {
        tx: a.tx_hash,
        priceUsd: Number(a.price_usd ?? a.token_price_usd ?? a.price_usd_buy ?? a.price), // tolerant
        amountUsd: Number(a.amount_usd ?? a.volume_usd ?? 0),
        amountToken: Number(a.amount_token ?? a.amount_out ?? a.amount_in ?? 0),
        tradeType: (a.trade_type || a.direction || '').toLowerCase(), // may be empty
        buyer: a.trader_address || null,
        ts: a.block_timestamp || a.timestamp
      };
    });
    return items;
  }
}

// ---------- Telegram commands ----------
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
      reply_markup: {
        inline_keyboard: [[{ text: '📈 Chart', url: chart }]]
      }
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
  } catch (e) {
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

// ---------- Poller (rotates pools to respect free rate limits) ----------
const queue = new PQueue({ interval: Number(POLL_INTERVAL_MS), intervalCap: 1 }); // 1 request / interval
let poolRoundRobin = []; // unique pools tracked by ANY chat

async function refreshPoolSet() {
  // union of pools from all chats (Redis scan)
  const keys = await redis.keys('chat:*:config');
  const set = new Set();
  for (const k of keys) {
    const cfg = JSON.parse(await redis.get(k));
    (cfg.pools || []).forEach(p => set.add(p));
  }
  poolRoundRobin = Array.from(set);
}
setInterval(refreshPoolSet, 10000); // refresh every 10s at runtime
refreshPoolSet();

// per-pool last TX to avoid duplicates
async function seen(pool, tx) {
  const key = `pool:${pool}:lastTx`;
  const last = await redis.get(key);
  if (last === tx) return true;
  await redis.set(key, tx);
  return false;
}

async function broadcastTrade(pool, trade) {
  // find all chats tracking this pool
  const keys = await redis.keys('chat:*:config');
  for (const k of keys) {
    const chatId = Number(k.split(':')[1]);
    const cfg = JSON.parse(await redis.get(k));
    if (!cfg.pools.includes(pool)) continue;

    const usd = Number(trade.amountUsd || 0);
    if (usd < (cfg.minBuyUsd || 0)) continue;

    // Only BUY (if tradeType provided; otherwise assume "buy" if amountToken>0 as a heuristic)
    const ttype = (trade.tradeType || '').toLowerCase();
    if (ttype && ttype !== 'buy') continue;

    const emoji = tierEmoji(cfg, usd);
    const symbol = cfg.tokenSymbols[pool] || 'TOKEN';
    const price = trade.priceUsd ? `$${trade.priceUsd.toFixed(6)}` : '—';
    const amountTok = trade.amountToken ? trade.amountToken.toLocaleString(undefined, {maximumFractionDigits: 6}) : '—';
    const txUrl = EXPLORER_TX_URL + trade.tx;
    const chart = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${pool}`;

    const caption = `${emoji} <b>BUY</b> • <b>${escapeHtml(symbol)}</b>\n` +
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
  // Take next pool in rotation
  const pool = poolRoundRobin.shift();
  poolRoundRobin.push(pool);
  const trades = await fetchTradesForPool(pool);
  if (!trades || !trades.length) return;
  // newest first
  const latest = trades[0];
  if (latest?.tx && await seen(pool, latest.tx)) return;
  if (latest?.tx) await broadcastTrade(pool, latest);
}

// schedule: 1 request per POLL_INTERVAL_MS (default 2s) → 30 req/min on free plan
setInterval(() => queue.add(tickOnce).catch(console.error), Number(POLL_INTERVAL_MS));
console.log('Buy bot started on network:', GECKO_NETWORK);
