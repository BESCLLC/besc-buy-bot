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
      [{ text: '📊 Status', callback_data: 'show_status' }]
    ]
  };
  return messageId
    ? bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard })
    : bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

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
  try {
    await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  } catch (e) {
    console.warn(`[Telegram] Leaderboard send failed:`, e.message);
  }
}

async function updateLeaderboard(chatId, buyer, usd) {
  const cfg = await getChat(chatId);
  if (!cfg.activeCompetition) return;
  if (usd < cfg.activeCompetition.minBuyUsd) return;
  cfg.activeCompetition.leaderboard[buyer] = (cfg.activeCompetition.leaderboard[buyer] || 0) + usd;
  await setChat(chatId, cfg);
}

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
    if (cfg.activeCompetition) await updateLeaderboard(chatId, trade.buyer || trade.tx, usd);

    try {
      const tokenAddr = trade.toToken || trade.fromToken;
      const tokenUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr?.toLowerCase()}`;
      const poolUrl = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}`;
      const [tokenRes, poolRes] = await Promise.all([
        axios.get(tokenUrl, { headers: { 'Accept': 'application/json;version=20230302' } }),
        axios.get(poolUrl, { headers: { 'Accept': 'application/json;version=20230302' } })
      ]);
      const tokenAttr = tokenRes?.data?.data?.attributes || {};
      const poolAttr = poolRes?.data?.data?.attributes || {};
      const decimals = cfg.decimalsOverrides[tokenAddr?.toLowerCase()] ?? tokenAttr.decimals ?? 18;
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

      let extraData = '';
      if (mcValue && mcValue > 0) extraData += `📊 ${mcLabel}: $${formatUSD(mcValue)}\n`;
      if (poolAttr.reserve_in_usd) extraData += `💧 Liquidity: $${formatUSD(Number(poolAttr.reserve_in_usd))}\n`;
      if (poolAttr.volume_usd_24h) extraData += `📈 24h Vol: $${formatUSD(Number(poolAttr.volume_usd_24h))}\n`;
      if (tokenAttr.unique_wallet_count) extraData += `👥 Holders: ${tokenAttr.unique_wallet_count}\n`;

      const isSell = trade.tradeType === 'sell';
      const emoji = isSell ? '🔴' : tierEmoji(cfg, usd);
      const caption =
        `${emoji} <b>${isSell ? 'SELL' : 'BUY'}</b> • <b>${escapeHtml(cfg.tokenSymbols[pool] || 'TOKEN')}</b>\n` +
        `💵 <b>$${usd.toFixed(2)}</b>\n` +
        `🧮 ${trade.amountToken?.toLocaleString(undefined,{maximumFractionDigits:6}) || '—'} @ ${price ? `$${price.toFixed(6)}` : '—'}\n` +
        extraData +
        (trade.buyer ? `👤 ${escapeHtml(trade.buyer.slice(0,6))}…${escapeHtml(trade.buyer.slice(-4))}\n` : '') +
        `🔗 <a href="${EXPLORER_TX_URL + trade.tx}">TX</a>`;
      try {
        if (cfg.gifFileId) await bot.sendAnimation(chatId, cfg.gifFileId, { caption, parse_mode: 'HTML' });
        else if (cfg.gifUrl) await bot.sendAnimation(chatId, cfg.gifUrl, { caption, parse_mode: 'HTML' });
        else await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
      } catch (err) {
        console.warn(`[Telegram] Failed to send to ${chatId}:`, err.message);
      }
    } catch (e) {
      console.warn(`[DEBUG] Extra data fetch failed:`, e.message);
    }
  }
}

// ---- Polling ----
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
