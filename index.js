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
  POLL_INTERVAL_MS = '1000' // Lightning fast: 1 second polling
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

// ULTRA-FAST QUEUES
const pollQueue = new PQueue({ concurrency: 3, interval: 800, intervalCap: 3 }); // 3 parallel API calls
const broadcastQueue = new PQueue({ concurrency: 10 }); // Broadcast to 10 chats simultaneously

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Health server on :', PORT));

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const memoryStore = new Map();

// State maps for inline flows
const pendingGif = new Map();
const awaitingTokenInput = new Map();
const awaitingMinBuyInput = new Map();
const awaitingTierInput = new Map();
const awaitingRemoveChoice = new Map();
const compWizard = new Map();
const awaitingGifUrl = new Map();

// BULLETPROOF ERROR HANDLING
process.on('uncaughtException', async (err) => {
  console.error('💥 CRASH:', new Date().toISOString(), err.message);
  console.error('Stack:', err.stack);
  // Don't crash - keep running
});

process.on('unhandledRejection', async (reason) => {
  console.error('💥 Unhandled Rejection:', new Date().toISOString(), reason);
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
    activeCompetition: null,
    lastValidation: 0,
    validationStatus: 'unknown'
  };
}

async function getChat(chatId) {
  try {
    if (!redis) return memoryStore.get(chatId) || defaultChatConfig();
    const raw = await redis.get(`chat:${chatId}:config`);
    if (raw) return JSON.parse(raw);
    const cfg = defaultChatConfig();
    await redis.set(`chat:${chatId}:config`, JSON.stringify(cfg), 'EX', 86400); // 24h expiry
    return cfg;
  } catch (e) {
    console.error(`[CONFIG ERROR] chat ${chatId}:`, e.message);
    return defaultChatConfig();
  }
}

async function setChat(chatId, cfg) {
  try {
    if (!redis) {
      memoryStore.set(chatId, cfg);
    } else {
      await redis.set(`chat:${chatId}:config`, JSON.stringify(cfg), 'EX', 86400);
    }
  } catch (e) {
    console.error(`[CONFIG SAVE ERROR] chat ${chatId}:`, e.message);
  }
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

// -------- BULLETPROOF TELEGRAM SENDER --------
async function safeSend(chatId, sendFn, maxRetries = 2) {
  const cfg = await getChat(chatId);
  const now = Date.now();
  
  // Auto-validate chat every 10 minutes
  if (now - (cfg.lastValidation || 0) > 600000) {
    const isValid = await validateChat(chatId, cfg);
    cfg.validationStatus = isValid ? 'valid' : 'invalid';
    cfg.lastValidation = now;
    await setChat(chatId, cfg);
  }
  
  const baseOpts = { 
    message_thread_id: cfg.validationStatus === 'valid' ? cfg.threadId : undefined,
    disable_web_page_preview: true 
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sendFn(baseOpts);
      return true; // Success
    } catch (e) {
      const desc = e.response?.body?.description || e.message || '';
      const errorCode = e.response?.body?.error_code || e.response?.status || 'unknown';
      
      console.log(`[SEND ${attempt}/${maxRetries}] Chat ${chatId}: ${errorCode} - ${desc.substring(0, 100)}`);
      
      // PERMANENT FAILURES - CLEAN UP CHAT
      if (desc.includes('not enough rights') || 
          desc.includes('forbidden') || 
          desc.includes('kicked') || 
          errorCode === 403) {
        console.log(`🚫 PERMANENTLY REMOVING invalid chat ${chatId}`);
        if (redis) await redis.del(`chat:${chatId}:config`);
        else memoryStore.delete(chatId);
        return false; // Don't retry
      }
      
      // THREAD ISSUES - AUTO-FIX
      if (desc.includes('message thread not found') || desc.includes('topic not found')) {
        console.log(`🔄 Auto-fixing invalid thread for chat ${chatId}`);
        cfg.threadId = null;
        cfg.validationStatus = 'needs_validation';
        await setChat(chatId, cfg);
        baseOpts.message_thread_id = undefined; // Fallback to main chat
        if (attempt === 1) continue; // Retry once without thread
      }
      
      // GIF/FILE ISSUES - FALLBACK TO TEXT
      if (desc.includes('file_id') || desc.includes('Bad Request: file to send not found')) {
        console.log(`🎥 GIF failed in chat ${chatId}, using text fallback`);
        cfg.gifFileId = null; // Disable broken GIF
        await setChat(chatId, cfg);
        continue; // Retry with text
      }
      
      // RATE LIMITS - BACKOFF
      if (errorCode === 429) {
        const wait = Math.min(1000 * Math.pow(2, attempt), 10000); // Max 10s
        console.log(`⏳ Rate limited, waiting ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      
      // NETWORK/TIMEOUT - RETRY
      if (errorCode === 'ETIMEDOUT' || errorCode === 'ECONNRESET' || attempt < maxRetries) {
        const wait = attempt * 500; // Progressive backoff
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      
      // FINAL FAILURE
      console.error(`💥 FINAL SEND FAILURE chat ${chatId} after ${maxRetries} attempts:`, desc);
      return false;
    }
  }
  return true;
}

async function validateChat(chatId, cfg) {
  try {
    // Try to send a test message
    const testSent = await safeSend(chatId, async (opts) => {
      const testMsg = await bot.sendMessage(chatId, '🤖', { ...opts });
      // Try to delete it (if we can send, we should be able to delete)
      setTimeout(() => {
        bot.deleteMessage(chatId, testMsg.message_id, { message_thread_id: opts.message_thread_id }).catch(() => {});
      }, 1000);
    }, 1); // Only 1 attempt for validation
    
    return testSent;
  } catch (e) {
    console.warn(`[VALIDATION FAILED] Chat ${chatId}:`, e.message);
    return false;
  }
}

// -------- SUPER FAST GECKO API WITH RETRIES --------
async function fetchTopPoolForToken(tokenAddr, retries = 2) {
  const url = `${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(url, {
        headers: { 'Accept': 'application/json;version=20230302' },
        timeout: 5000,
        validateStatus: () => true
      });
      
      if (data?.data?.relationships?.top_pools?.data?.[0]) {
        const poolId = data.data.relationships.top_pools.data[0].id;
        const pool = poolId.split('_').pop();
        const symbol = data.data.attributes.symbol || 'TOKEN';
        return { pool, symbol };
      }
      
      return null;
    } catch (e) {
      if (attempt === retries) {
        console.error(`[GECKO] Top pool FINAL fail for ${tokenAddr.slice(0,10)}...:`, e.message);
        return null;
      }
      // Quick retry for network issues
      if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
}

async function fetchTradesForPool(pool, retries = 3) {
  const url = `${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}/trades?limit=3`;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: { 'Accept': 'application/json;version=20230302' },
        timeout: 4000,
        validateStatus: () => true
      });
      
      const { data } = response;
      
      if (data?.data && Array.isArray(data.data)) {
        const trades = normalizeTrades(data.data);
        if (trades.length > 0) {
          console.log(`✅ Pool ${pool.slice(0,8)}... found ${trades.length} recent trades`);
        }
        return trades;
      }
      
      // 404 = pool doesn't exist anymore
      if (response.status === 404) {
        await notifyPoolGone(pool);
        return [];
      }
      
      return [];
    } catch (e) {
      const errorInfo = e.response?.status || e.code || e.message;
      
      if (attempt === retries) {
        console.error(`[GECKO] Pool ${pool.slice(0,8)}... FINAL fail after ${retries} attempts:`, errorInfo);
        return [];
      }
      
      // Handle different error types
      if (e.response?.status === 429) {
        // Rate limited - wait longer
        await new Promise(r => setTimeout(r, 3000));
      } else if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') {
        // Network issue - quick retry
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      } else {
        // Other errors - standard backoff
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  
  return [];
}

// Prevent spam notifications for dead pools
let poolGoneNotified = new Set();

async function notifyPoolGone(pool) {
  if (poolGoneNotified.has(pool)) return;
  poolGoneNotified.add(pool);
  
  console.log(`⚠️ Notifying about dead pool: ${pool.slice(0,8)}...`);
  
  // Notify all chats tracking this pool
  const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
  for (const k of keys) {
    const chatId = Number(k.split(':')[1]);
    try {
      const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
      if (cfg?.pools.includes(pool)) {
        await safeSend(chatId, async (opts) => {
          await bot.sendMessage(chatId, 
            `⚠️ <b>Pool Removed</b>\n\nPool <code>${pool.slice(0,6)}…${pool.slice(-4)}</code> no longer exists on GeckoTerminal.\n\nUse <code>/settings</code> to remove it.`, 
            { parse_mode: 'HTML', ...opts }
          );
        });
      }
    } catch (e) {
      // Silent fail - chat might be invalid anyway
    }
  }
  
  // Clear notification after 1 hour
  setTimeout(() => poolGoneNotified.delete(pool), 3600000);
}

function normalizeTrades(items) {
  return (items || [])
    .map(x => {
      const a = x.attributes || {};
      const kind = (a.kind || '').toLowerCase();
      const isSell = kind === 'sell';
      const tokenAmount = Number(isSell ? a.from_token_amount : a.to_token_amount);
      const usdAmount = Number(a.volume_in_usd ?? 0);
      
      // Skip zero-value trades
      if (usdAmount <= 0) return null;
      
      return {
        id: x.id,
        tx: a.tx_hash,
        priceUsd: Number(a.price_to_in_usd ?? a.price_from_in_usd ?? 0),
        amountUsd: usdAmount,
        amountToken: tokenAmount,
        tradeType: kind,
        buyer: a.tx_from_address || null,
        fromToken: a.from_token_address,
        toToken: a.to_token_address,
        ts: new Date(a.block_timestamp).getTime()
      };
    })
    .filter(Boolean) // Remove null trades
    .sort((a, b) => b.ts - a.ts); // Newest first
}

// -------- OPTIMIZED POOL MANAGEMENT --------
let poolRoundRobin = [];
let activePools = new Map(); // Track pool activity

async function refreshPoolSet() {
  try {
    const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
    const poolSet = new Set();
    const poolChatMap = new Map(); // pool -> [chatIds]
    
    for (const k of keys) {
      const chatId = Number(k.split(':')[1]);
      try {
        const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
        if (!cfg || !cfg.pools?.length) continue;
        
        cfg.pools.forEach(pool => {
          poolSet.add(pool);
          if (!poolChatMap.has(pool)) poolChatMap.set(pool, []);
          poolChatMap.get(pool).push(chatId);
        });
      } catch (e) {
        console.warn(`[REFRESH] Failed to process chat ${chatId}:`, e.message);
      }
    }
    
    // Sort by activity - most recently traded pools first
    poolRoundRobin = Array.from(poolSet).sort((a, b) => {
      const aActivity = activePools.get(a)?.lastTrade || 0;
      const bActivity = activePools.get(b)?.lastTrade || 0;
      return bActivity - aActivity;
    });
    
    console.log(`🔄 Refreshed: ${poolRoundRobin.length} pools across ${keys.length} chats`);
    
    // Quick validation for active chats (sample 1 per pool)
    const validationPromises = Array.from(poolChatMap.entries()).slice(0, 5).map(async ([pool, chats]) => {
      if (chats.length > 0) {
        const sampleChat = chats[0];
        const cfg = await getChat(sampleChat);
        await validateChat(sampleChat, cfg);
      }
    });
    
    await Promise.allSettled(validationPromises);
    
  } catch (e) {
    console.error('[REFRESH ERROR]:', e.message);
  }
}

// Refresh every 15 seconds
setInterval(refreshPoolSet, 15000);
refreshPoolSet();

async function seen(pool, tradeId) {
  if (!tradeId) return true; // Invalid ID = already seen
  
  try {
    const key = `pool:${pool}:lastTradeId`;
    const last = redis ? await redis.get(key) : memoryStore.get(key);
    
    if (last === tradeId) {
      return true;
    }
    
    // Mark as seen with TTL
    if (redis) {
      await redis.set(key, tradeId, 'EX', 7200); // 2h expiry
    } else {
      memoryStore.set(key, tradeId);
    }
    
    // Update pool activity
    activePools.set(pool, { 
      lastTrade: Date.now(), 
      lastId: tradeId,
      tradeCount: (activePools.get(pool)?.tradeCount || 0) + 1 
    });
    
    return false;
  } catch (e) {
    console.error('[SEEN ERROR]:', e.message);
    return true; // Assume seen on error to prevent spam
  }
}

// -------- LIGHTNING-FAST BROADCASTING --------
async function broadcastTrade(pool, trade) {
  try {
    // Get all valid chats for this pool
    const chatIds = await getValidChatsForPool(pool);
    if (!chatIds.length) {
      console.log(`📭 No valid chats for pool ${pool.slice(0,8)}... trade $${trade.amountUsd}`);
      return;
    }
    
    console.log(`🚀 Broadcasting ${trade.tradeType} $${trade.amountUsd.toFixed(0)} to ${chatIds.length} chats (pool: ${pool.slice(0,8)}...)`);
    
    // Parallel broadcast with priority for big trades
    const broadcastPromises = chatIds.map(chatId => 
      broadcastQueue.add(() => processTradeForChat(chatId, pool, trade), {
        priority: trade.amountUsd > 1000 ? 1 : 0 // Big trades first
      })
    );
    
    const results = await Promise.allSettled(broadcastPromises);
    
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.filter(r => r.status === 'rejected').length;
    
    if (failCount > 0) {
      console.log(`📢 ${successCount}/${chatIds.length} chats received alert (pool: ${pool.slice(0,8)}...)`);
    }
    
  } catch (e) {
    console.error('[BROADCAST ERROR]:', e.message);
  }
}

async function getValidChatsForPool(pool) {
  const validChats = [];
  const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
  
  // Parallel chat validation
  const chatPromises = keys.map(async (k) => {
    const chatId = Number(k.split(':')[1]);
    try {
      const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
      if (cfg?.pools.includes(pool) && cfg.validationStatus !== 'invalid') {
        validChats.push(chatId);
      }
    } catch (e) {
      // Silent fail
    }
  });
  
  await Promise.allSettled(chatPromises);
  return validChats;
}

async function processTradeForChat(chatId, pool, trade) {
  try {
    const cfg = await getChat(chatId);
    
    // Quick filters
    if (trade.tradeType === 'sell' && !cfg.showSells) return;
    const usd = Number(trade.amountUsd || 0);
    if (usd < (cfg.minBuyUsd || 0)) return;
    
    // Update competition leaderboard
    if (cfg.activeCompetition && trade.tradeType === 'buy' && usd >= cfg.activeCompetition.minBuyUsd) {
      const walletKey = trade.buyer || trade.tx;
      cfg.activeCompetition.leaderboard[walletKey] = 
        (cfg.activeCompetition.leaderboard[walletKey] || 0) + usd;
      await setChat(chatId, cfg);
    }
    
    // Build message components
    const messageData = await buildTradeMessage(cfg, pool, trade);
    if (!messageData) return;
    
    // Send with bulletproof handling
    const sent = await safeSend(chatId, async (opts) => {
      await sendTradeMessage(chatId, messageData, cfg, opts);
    });
    
    if (sent) {
      console.log(`✅ Alert sent to chat ${chatId} - ${trade.tradeType} $${usd.toFixed(0)}`);
    }
    
  } catch (e) {
    console.error(`[PROCESS ERROR] chat ${chatId}:`, e.message);
  }
}

async function buildTradeMessage(cfg, pool, trade) {
  const isSell = trade.tradeType === 'sell';
  const usd = Number(trade.amountUsd);
  const symbol = cfg.tokenSymbols[pool] || 'TOKEN';
  
  // Final validation
  if (isSell && !cfg.showSells) return null;
  if (usd < (cfg.minBuyUsd || 0)) return null;
  
  // Get market data in parallel (non-blocking)
  let extraData = '';
  const extraDataPromise = (async () => {
    try {
      const tokenAddr = trade.toToken || trade.fromToken;
      if (!tokenAddr) return '';
      
      const [tokenRes, poolRes] = await Promise.allSettled([
        axios.get(`${GT_BASE}/networks/${GECKO_NETWORK}/tokens/${tokenAddr.toLowerCase()}`),
        axios.get(`${GT_BASE}/networks/${GECKO_NETWORK}/pools/${pool}`)
      ]);
      
      // Token data
      if (tokenRes.status === 'fulfilled' && tokenRes.value?.data?.data) {
        const tokenAttr = tokenRes.value.data.data.attributes || {};
        const price = Number(trade.priceUsd || tokenAttr.price_usd || 0);
        
        // Quick MC/FDV calculation
        let mcValue = Number(tokenAttr.market_cap_usd ?? 0);
        let mcLabel = 'MC';
        
        if (!mcValue && price > 0) {
          const circ = adjustSupply(tokenAttr.circulating_supply, tokenAttr.decimals ?? 18);
          if (circ > 0) {
            mcValue = circ * price;
          } else {
            mcValue = Number(tokenAttr.fdv_usd ?? 0);
            mcLabel = 'FDV';
          }
        }
        
        if (mcValue > 0) {
          extraData += `📊 ${mcLabel}: $${formatUSD(mcValue)}\n`;
        }
        
        // 24h change
        if (tokenAttr.price_percent_change_24h != null) {
          const pct = Number(tokenAttr.price_percent_change_24h);
          if (Number.isFinite(pct)) {
            extraData += `📈 24h: ${pct >= 0 ? '+' : ''}${Math.round(pct * 10) / 10}%\n`;
          }
        }
        
        // Holders
        if (tokenAttr.unique_wallet_count) {
          extraData += `👥 Holders: ${Number(tokenAttr.unique_wallet_count).toLocaleString()}\n`;
        }
      }
      
      // Pool data
      if (poolRes.status === 'fulfilled' && poolRes.value?.data?.data) {
        const poolAttr = poolRes.value.data.data.attributes || {};
        if (poolAttr.reserve_in_usd) {
          extraData += `💧 Liquidity: $${formatUSD(Number(poolAttr.reserve_in_usd))}\n`;
        }
      }
      
    } catch (e) {
      // Silent fail - don't block the alert
    }
  })();
  
  // Wait max 800ms for extra data
  await Promise.race([extraDataPromise, new Promise(r => setTimeout(r, 800))]);
  
  const emoji = isSell ? '🔴' : tierEmoji(cfg, usd);
  const action = isSell ? 'SELL' : 'BUY';
  const priceStr = trade.priceUsd ? `$${trade.priceUsd.toFixed(6)}` : '—';
  const amountTok = trade.amountToken ? 
    Number(trade.amountToken).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
  
  const txUrl = `${EXPLORER_TX_URL}${trade.tx}`;
  const chartUrl = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${pool}`;
  
  const baseMessage = `${emoji} <b>${action}</b> • <b>${escapeHtml(symbol)}</b>\n` +
    `💵 <b>$${usd.toFixed(2)}</b>\n` +
    `🧮 ${amountTok} ${escapeHtml(symbol)} @ ${priceStr}\n` +
    extraData +
    (trade.buyer ? `👤 ${escapeHtml(trade.buyer.slice(0,6))}…${escapeHtml(trade.buyer.slice(-4))}\n` : '') +
    `🔗 <a href="${txUrl}">TX</a>`;
  
  const hasUniversalGif = !!cfg.gifUrl;
  const hasLocalGif = !!(cfg.gifFileId && cfg.gifChatId === chatId);
  
  return {
    baseMessage,
    chartUrl,
    txUrl,
    hasUniversalGif,
    hasLocalGif,
    parseMode: 'HTML',
    keyboard: {
      inline_keyboard: [[
        { text: '📈 Chart', url: chartUrl },
        { text: '🔗 TX', url: txUrl }
      ]]
    }
  };
}

async function sendTradeMessage(chatId, messageData, cfg, opts) {
  try {
    if (messageData.hasUniversalGif && cfg.gifUrl) {
      // Universal GIF URL - works everywhere
      await bot.sendAnimation(chatId, cfg.gifUrl, {
        caption: messageData.baseMessage,
        parse_mode: messageData.parseMode,
        reply_markup: messageData.keyboard,
        ...opts
      });
    } else if (messageData.hasLocalGif) {
      // Local file_id - only works in originating chat
      await bot.sendAnimation(chatId, cfg.gifFileId, {
        caption: messageData.baseMessage,
        parse_mode: messageData.parseMode,
        reply_markup: messageData.keyboard,
        ...opts
      });
    } else {
      // Text-only fallback - always works
      await bot.sendMessage(chatId, messageData.baseMessage, {
        parse_mode: messageData.parseMode,
        reply_markup: messageData.keyboard,
        ...opts
      });
    }
  } catch (e) {
    // Final fallback - just send plain text without markup
    console.warn(`[FINAL FALLBACK] Chat ${chatId}:`, e.message);
    await bot.sendMessage(chatId, messageData.baseMessage.replace(/<[^>]*>/g, ''), {
      disable_web_page_preview: true,
      ...opts
    });
  }
}

// -------- ULTRA-FAST TICK ENGINE --------
async function tickOnce() {
  if (!poolRoundRobin.length) return;
  
  try {
    // Get next pool (most active first)
    const pool = poolRoundRobin.shift();
    poolRoundRobin.push(pool);
    
    // Parallel, non-blocking API call
    const trades = await pollQueue.add(() => fetchTradesForPool(pool), { 
      retries: 2,
      minTimeout: 100 
    });
    
    if (!trades?.length) return;
    
    // Only process newest trade
    const latest = trades[0];
    if (!latest || !latest.id) return;
    
    // Super-fast duplicate check
    const isNew = await seen(pool, latest.id);
    if (isNew) {
      // LIGHTNING BROADCAST - no delays!
      broadcastTrade(pool, latest).catch(e => {
        console.error('[BROADCAST FAILED]:', e.message);
      });
    }
  } catch (e) {
    // Silent fail - don't break the tick loop
    console.error('[TICK ERROR]:', e.message);
  }
}

// 🔥 LIGHTNING FAST: Every 1 second
setInterval(() => {
  tickOnce();
}, Number(POLL_INTERVAL_MS));

// -------- ENHANCED SETTINGS PANEL --------
async function sendSettingsPanel(chatId, messageId = null) {
  try {
    const cfg = await getChat(chatId);
    const tokens = cfg.pools.length
      ? cfg.pools.map(p => {
          const symbol = cfg.tokenSymbols[p] || (p.slice(0,6) + '…' + p.slice(-4));
          return symbol.length > 20 ? symbol.substring(0, 17) + '...' : symbol;
        }).join(', ')
      : 'None';
    
    const statusEmoji = cfg.validationStatus === 'valid' ? '🟢' : 
                       cfg.validationStatus === 'invalid' ? '🔴' : '🟡';
    
    const gifStatus = cfg.gifUrl ? '🌐 URL' : 
                     (cfg.gifFileId ? `📎 Local (${cfg.gifChatId})` : '❌ None');
    
    const compStatus = cfg.activeCompetition ? 
      `🏆 ACTIVE\n⏳ ${Math.max(0, Math.round((cfg.activeCompetition.endsAt - Date.now()) / 60000))}min left` : '—';
    
    const text = `${statusEmoji} <b>BESC Trade Bot v2.0</b>\n\n` +
      `<b>Network:</b> ${GECKO_NETWORK.replace('-', ' ').toUpperCase()}\n` +
      `<b>Status:</b> ${cfg.validationStatus === 'valid' ? '🟢 Active' : '🔴 Needs Setup'}\n` +
      `<b>Tracking:</b> ${escapeHtml(tokens)}\n` +
      `<b>Min Buy:</b> $${cfg.minBuyUsd}\n` +
      `<b>Tiers:</b> $${cfg.tiers.large} ${cfg.emoji.large} | $${cfg.tiers.small} ${cfg.emoji.mid}\n` +
      `<b>Sells:</b> ${cfg.showSells ? '🔴 Enabled' : '❌ Disabled'}\n` +
      `<b>GIF:</b> ${gifStatus}\n` +
      `<b>Competition:</b> ${compStatus}\n\n` +
      `<i>Updated: ${new Date().toLocaleTimeString()}</i>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '➕ Add Token', callback_data: 'add_token' },
          { text: '➖ Remove Token', callback_data: 'remove_token' }
        ],
        [
          { text: `🎯 Min Buy $${cfg.minBuyUsd}`, callback_data: 'set_minbuy' },
          { text: '🐋 Tiers', callback_data: 'tier_menu' }
        ],
        [{ text: cfg.showSells ? '🔴 Hide Sells' : '🟢 Show Sells', callback_data: 'toggle_sells' }],
        [
          { text: '🎞️ GIF URL', callback_data: 'set_gif_url' },
          { text: '📎 Local GIF', callback_data: 'set_gif' },
          { text: '🗑️ Clear GIF', callback_data: 'remove_gif' }
        ],
        [
          { text: '🏆 Start Comp', callback_data: 'start_comp' },
          { text: '📊 Leaderboard', callback_data: 'show_leaderboard' },
          { text: '🛑 End Comp', callback_data: 'end_comp' }
        ],
        [
          { text: `${statusEmoji} Check Setup`, callback_data: 'check_rights' },
          { text: '🔄 Reset Thread', callback_data: 'reset_thread' }
        ],
        [{ text: '📋 Status', callback_data: 'show_status' }],
        [{ text: '✅ Done', callback_data: 'done_settings' }]
      ]
    };

    const panelOpts = { message_thread_id: cfg.threadId || undefined };

    if (messageId) {
      // Try to edit existing message
      try {
        await bot.editMessageText(text, { 
          chat_id: chatId, 
          message_id: messageId, 
          parse_mode: 'HTML', 
          reply_markup: keyboard, 
          ...panelOpts 
        });
        return;
      } catch (editError) {
        if (!editError.message.includes("message can't be edited")) {
          console.warn(`[PANEL EDIT FAIL] ${chatId}:`, editError.message);
        }
        // Fall through to new message
      }
    }

    // Send new message
    await bot.sendMessage(chatId, text, { 
      parse_mode: 'HTML', 
      reply_markup: keyboard, 
      ...panelOpts 
    });

  } catch (error) {
    console.error(`[PANEL ERROR] ${chatId}:`, error.message);
    // Emergency fallback
    try {
      await bot.sendMessage(chatId, 
        `⚙️ <b>Settings Panel</b>\n\n` +
        `❌ Error loading settings. Try <code>/status</code> or restart with <code>/settings</code>.\n\n` +
        `💡 <b>Quick Fix:</b> Make sure bot has "Post Messages" permission.`, 
        { parse_mode: 'HTML' }
      );
    } catch (fallbackError) {
      console.error('[EMERGENCY FALLBACK FAILED]:', fallbackError.message);
    }
  }
}

// -------- ENHANCED CALLBACK HANDLER --------
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageThreadId = query.message.message_thread_id;
  await bot.answerCallbackQuery(query.id);
  
  try {
    const cfg = await getChat(chatId);
    const opts = { message_thread_id: messageThreadId || cfg.threadId || undefined };

    switch (query.data) {
      case 'add_token':
        awaitingTokenInput.set(chatId, { type: 'token', msgId: query.message.message_id });
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, '💎 <b>Add Token</b>\n\nReply with token address:\n<code>0x1234...</code>\n\nOr use <code>/add 0x1234...</code>', { 
            parse_mode: 'HTML', ...o 
          });
        });
        break;

      case 'remove_token':
        if (!cfg.pools.length) {
          await safeSend(chatId, async (o) => {
            await bot.sendMessage(chatId, '📭 No tokens tracking yet.\n\nUse ➕ Add Token to start.', { ...o });
          });
          return;
        }
        
        const rows = cfg.pools.slice(0, 10).map(p => ([{
          text: (cfg.tokenSymbols[p] || p.slice(0,8) + '…' + p.slice(-4)),
          callback_data: `rm:${p}`
        }]));
        
        if (cfg.pools.length > 10) {
          rows.push([{ text: `... +${cfg.pools.length - 10} more`, callback_data: 'show_all_pools' }]);
        }
        
        rows.push([{ text: '⬅️ Back', callback_data: 'back_to_settings' }]);
        
        await safeSend(chatId, async (o) => {
          await bot.editMessageText('🗑️ <b>Remove Token</b>\n\nSelect token to stop tracking:', {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: rows },
            ...o
          });
        });
        
        awaitingRemoveChoice.set(chatId, query.message.message_id);
        break;

      case 'done_settings':
        try {
          await bot.deleteMessage(chatId, query.message.message_id, opts);
        } catch (e) {
          // Ignore delete errors
        }
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, '✅ <b>Settings saved!</b>\n\nBot will continue monitoring your tokens.', { 
            parse_mode: 'HTML', ...o 
          });
        });
        break;

      case 'set_minbuy':
        awaitingMinBuyInput.set(chatId, query.message.message_id);
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, '💰 <b>Set Minimum Buy</b>\n\nReply with USD amount:\n• <code>50</code> = $50 minimum\n• <code>0</code> = show all buys', { 
            parse_mode: 'HTML', ...o 
          });
        });
        break;

      case 'tier_menu':
        await safeSend(chatId, async (o) => {
          await bot.editMessageText(
            `🐋 <b>Whale Tiers</b>\n\n` +
            `Current: Small $${cfg.tiers.small} ${cfg.emoji.small}\n` +
            `         Large $${cfg.tiers.large} ${cfg.emoji.large}\n\n` +
            `Set thresholds for emoji alerts:`,
            {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: `Small: $${cfg.tiers.small}`, callback_data: 'set_tier_small' },
                    { text: `Large: $${cfg.tiers.large}`, callback_data: 'set_tier_large' }
                  ],
                  [{ text: '⬅️ Back', callback_data: 'back_to_settings' }]
                ]
              },
              ...opts
            }
          );
        });
        break;

      case 'set_tier_small':
        awaitingTierInput.set(chatId, { which: 'small', msg: query.message.message_id });
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, '🟢 <b>Small Tier</b>\n\nReply with USD threshold for small buys\n(e.g. <code>50</code> for $50+ = 🟢):', { 
            parse_mode: 'HTML', ...o 
          });
        });
        break;

      case 'set_tier_large':
        awaitingTierInput.set(chatId, { which: 'large', msg: query.message.message_id });
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, '🐋 <b>Whale Tier</b>\n\nReply with USD threshold for whale buys\n(e.g. <code>1000</code> for $1000+ = 🐋):', { 
            parse_mode: 'HTML', ...o 
          });
        });
        break;

      case 'toggle_sells':
        cfg.showSells = !cfg.showSells;
        await setChat(chatId, cfg);
        await safeSend(chatId, async (o) => {
          await bot.answerCallbackQuery(query.id, { 
            text: `Sell alerts ${cfg.showSells ? '🔴 ENABLED' : '❌ DISABLED'}` 
          });
          await sendSettingsPanel(chatId, query.message.message_id);
        });
        break;

      case 'set_gif_url':
        awaitingGifUrl.set(chatId, query.message.message_id);
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            '🌐 <b>Universal GIF</b>\n\n' +
            'Send me a GIF URL that works everywhere:\n' +
            '• Giphy: <code>https://giphy.com/gifs/...</code>\n' +
            '• Imgur: <code>https://i.imgur.com/abc.gif</code>\n\n' +
            '<i>URL GIFs work in all chats!</i>', 
            { parse_mode: 'HTML', ...o }
          );
        });
        break;

      case 'set_gif':
        pendingGif.set(chatId, true);
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            '📎 <b>Local GIF</b>\n\n' +
            'Send animation/GIF file:\n' +
            '• Works only in <b>this chat</b>\n' +
            '• Use URL option for cross-chat', 
            { parse_mode: 'HTML', ...o }
          );
        });
        break;

      case 'remove_gif':
        cfg.gifFileId = null;
        cfg.gifUrl = null;
        cfg.gifChatId = null;
        await setChat(chatId, cfg);
        await bot.answerCallbackQuery(query.id, { text: '🗑️ GIF removed' });
        await sendSettingsPanel(chatId, query.message.message_id);
        break;

      case 'reset_thread':
        cfg.threadId = null;
        cfg.validationStatus = 'needs_validation';
        await setChat(chatId, cfg);
        console.log(`[INFO] Manual thread reset for chat ${chatId}`);
        await bot.answerCallbackQuery(query.id, { text: '🔄 Thread cleared' });
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            '✅ <b>Thread Reset</b>\n\n' +
            'Topic thread ID cleared.\n' +
            'Run <code>/settings</code> in desired topic to set new one.', 
            { parse_mode: 'HTML', ...o }
          );
        });
        await sendSettingsPanel(chatId, query.message.message_id);
        break;

      case 'check_rights':
        const isAdmin = await checkBotAdminStatus(chatId);
        const rightsText = isAdmin ? 
          '✅ <b>Bot Status: PERFECT</b>\n\nBot has full permissions!\n• ✅ Post Messages\n• ✅ Send Media\n• ✅ Inline Keyboards' :
          '🔴 <b>Bot Needs Admin Rights</b>\n\n' +
          'To fix: Make bot admin with "Post Messages" permission\n\n' +
          '💡 <i>Group Settings → Administrators → Add Bot</i>';
        
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, rightsText, { parse_mode: 'HTML', ...o });
        });
        break;

      case 'show_status':
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            'Use <code>/status</code> for detailed configuration\n' +
            'or <code>/help</code> for full command list', 
            { parse_mode: 'HTML', ...o }
          );
        });
        break;

      case 'back_to_settings':
        await sendSettingsPanel(chatId, query.message.message_id);
        break;

      case 'start_comp':
        compWizard.set(chatId, { step: 1, data: {} });
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            '🏆 <b>Start Buy Competition</b>\n\n' +
            'Step 1/4: Enter duration in minutes:\n' +
            '<code>30</code> = 30 minutes\n' +
            '<code>60</code> = 1 hour', 
            { parse_mode: 'HTML', ...o }
          );
        });
        break;

      case 'show_leaderboard':
        await postLeaderboard(chatId, false);
        break;

      case 'end_comp':
        if (cfg.activeCompetition) {
          await postLeaderboard(chatId, true);
          cfg.activeCompetition = null;
          await setChat(chatId, cfg);
          await safeSend(chatId, async (o) => {
            await bot.sendMessage(chatId, '🛑 <b>Competition Ended!</b>\n\nFinal leaderboard posted above.', { 
              parse_mode: 'HTML', ...o 
            });
          });
        } else {
          await safeSend(chatId, async (o) => {
            await bot.sendMessage(chatId, '📭 No active competition to end.', { ...o });
          });
        }
        break;

      // Remove pool
      case /^rm:/.test(query.data):
        const poolToRemove = query.data.slice(3);
        const updatedCfg = await getChat(chatId);
        
        if (updatedCfg.pools.includes(poolToRemove)) {
          updatedCfg.pools = updatedCfg.pools.filter(p => p !== poolToRemove);
          delete updatedCfg.tokenSymbols[poolToRemove];
          await setChat(chatId, updatedCfg);
          
          await bot.answerCallbackQuery(query.id, { 
            text: `🗑️ Removed ${updatedCfg.tokenSymbols[poolToRemove] || poolToRemove.slice(0,8)}...` 
          });
        } else {
          await bot.answerCallbackQuery(query.id, { text: '❓ Token not found' });
        }
        
        const msgId = awaitingRemoveChoice.get(chatId) || query.message.message_id;
        awaitingRemoveChoice.delete(chatId);
        await sendSettingsPanel(chatId, msgId);
        break;

      default:
        console.log(`[UNKNOWN CALLBACK] ${query.data}`);
        break;
    }
  } catch (error) {
    console.error(`[CALLBACK ERROR] ${chatId}:`, error.message);
    await bot.answerCallbackQuery(query.id, { 
      text: '⚠️ Error processing request', 
      show_alert: true 
    });
  }
});

// -------- ENHANCED MESSAGE HANDLER --------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  // Ignore commands
  if (msg.text && msg.text.startsWith('/')) return;
  
  // Handle GIF uploads
  if (msg.animation && pendingGif.has(chatId)) {
    const cfg = await getChat(chatId);
    cfg.gifFileId = msg.animation.file_id;
    cfg.gifUrl = null;
    cfg.gifChatId = chatId;
    await setChat(chatId, cfg);
    pendingGif.delete(chatId);
    
    await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        '✅ <b>Local GIF Saved!</b>\n\n' +
        `📎 File: ${msg.animation.file_name || 'animation.gif'}\n` +
        `🎭 Will play on buy alerts <b>in this chat only</b>\n\n` +
        `💡 Use "GIF URL" option for cross-chat compatibility`, 
        { parse_mode: 'HTML', ...o }
      );
    });
    return;
  }
  
  // Handle GIF URL input
  if (awaitingGifUrl.has(chatId) && msg.text) {
    const url = msg.text.trim();
    const msgId = awaitingGifUrl.get(chatId);
    
    if (url.startsWith('http') && (url.includes('.gif') || url.includes('giphy.com'))) {
      const cfg = await getChat(chatId);
      cfg.gifUrl = url;
      cfg.gifFileId = null;
      cfg.gifChatId = null;
      await setChat(chatId, cfg);
      awaitingGifUrl.delete(chatId);
      
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          '🌐 <b>Universal GIF Saved!</b>\n\n' +
          `🔗 URL: <a href="${url}">${url.substring(0, 30)}...</a>\n` +
          `🎭 Will work in <b>all chats</b> where bot is active!\n\n` +
          `💡 Perfect for community-wide alerts`, 
          { parse_mode: 'HTML', disable_web_page_preview: true, ...o }
        );
      });
      await sendSettingsPanel(chatId, msgId);
    } else {
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          '❌ <b>Invalid GIF URL</b>\n\n' +
          'Please send a direct GIF link:\n' +
          '• <code>https://giphy.com/gifs/abc-123.gif</code>\n' +
          '• <code>https://i.imgur.com/xyz.gif</code>\n\n' +
          'Must end in .gif or be from Giphy', 
          { parse_mode: 'HTML', ...o }
        );
      });
    }
    return;
  }
  
  if (!msg.text) return;

  const cfg = await getChat(chatId);
  const opts = { message_thread_id: cfg.threadId || undefined };

  // Token address input
  if (awaitingTokenInput.has(chatId)) {
    const state = awaitingTokenInput.get(chatId);
    const token = msg.text.trim();
    const isAddr = /^0x[a-fA-F0-9]{40}$/.test(token);
    const msgId = state.msgId;
    awaitingTokenInput.delete(chatId);
    
    if (!isAddr) {
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          '❌ <b>Invalid Address</b>\n\n' +
          'Please send valid token address:\n' +
          '<code>0x1234567890abcdef1234567890abcdef12345678</code>\n\n' +
          'Must be exactly 42 characters starting with 0x', 
          { parse_mode: 'HTML', ...o }
        );
      });
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    
    const topPool = await fetchTopPoolForToken(token);
    if (topPool) {
      const updatedCfg = await getChat(chatId);
      if (!updatedCfg.pools.includes(topPool.pool)) {
        updatedCfg.pools.push(topPool.pool);
        updatedCfg.tokenSymbols[topPool.pool] = topPool.symbol;
        await setChat(chatId, updatedCfg);
      }
      
      const chartUrl = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${topPool.pool}`;
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          `✅ <b>Now Tracking ${escapeHtml(topPool.symbol)}</b>\n\n` +
          `📊 Token: <code>${token}</code>\n` +
          `🔗 Pool: <code>${topPool.pool}</code>\n` +
          `⏰ Started: ${new Date().toLocaleTimeString()}\n\n` +
          `💡 First buy alert will appear in ~1-2 seconds`, 
          { 
            parse_mode: 'HTML', 
            reply_markup: { 
              inline_keyboard: [[{ text: '📈 View Chart', url: chartUrl }]] 
            }, 
            ...o 
          }
        );
      });
      await sendSettingsPanel(chatId, msgId);
    } else {
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          `❌ <b>No Pool Found</b>\n\n` +
          `Token <code>${token}</code> has no liquidity pool on ${GECKO_NETWORK.replace('-', ' ').toUpperCase()} yet.\n\n` +
          `💡 Try:\n• Check token address\n• Wait for pool creation\n• Try popular tokens`, 
          { parse_mode: 'HTML', ...o }
        );
      });
      await sendSettingsPanel(chatId, msgId);
    }
    return;
  }

  // Min buy input
  if (awaitingMinBuyInput.has(chatId)) {
    const val = Number(msg.text);
    const msgId = awaitingMinBuyInput.get(chatId);
    awaitingMinBuyInput.delete(chatId);
    
    if (!Number.isFinite(val) || val < 0) {
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          '❌ <b>Invalid Amount</b>\n\n' +
          'Please enter valid USD amount:\n' +
          '• <code>0</code> = show all buys\n' +
          '• <code>25</code> = $25 minimum\n' +
          '• <code>100.50</code> = $100.50 minimum', 
          { parse_mode: 'HTML', ...o }
        );
      });
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    
    const updatedCfg = await getChat(chatId);
    updatedCfg.minBuyUsd = val;
    await setChat(chatId, updatedCfg);
    
    await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        `✅ <b>Minimum Buy Set</b>\n\n` +
        `💰 New threshold: <b>$${val}</b>\n` +
        `⏰ Will start filtering alerts immediately\n\n` +
        `💡 <i>$0 = show all buys (including dust)</i>`, 
        { parse_mode: 'HTML', ...o }
      );
    });
    await sendSettingsPanel(chatId, msgId);
    return;
  }

  // Tier input
  if (awaitingTierInput.has(chatId)) {
    const { which, msg: msgId } = awaitingTierInput.get(chatId);
    awaitingTierInput.delete(chatId);
    const val = Number(msg.text);
    
    if (!Number.isFinite(val) || val < 0) {
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          '❌ <b>Invalid Threshold</b>\n\n' +
          `Please enter valid USD amount for ${which.toUpperCase()} tier:\n` +
          '• <code>100</code> = $100 threshold\n' +
          '• <code>500.25</code> = $500.25 threshold', 
          { parse_mode: 'HTML', ...o }
        );
      });
      await sendSettingsPanel(chatId, msgId);
      return;
    }
    
    const updatedCfg = await getChat(chatId);
    updatedCfg.tiers[which] = val;
    await setChat(chatId, updatedCfg);
    
    const tierName = which === 'small' ? 'Small' : 'Whale';
    const emoji = updatedCfg.emoji[which];
    
    await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        `✅ <b>${tierName} Tier Updated</b>\n\n` +
        `💎 ${tierName}: <b>$${val}</b> ${emoji}\n` +
        `⏰ New threshold active immediately\n\n` +
        `💡 Buys ≥ $${val} will show ${emoji} emoji`, 
        { parse_mode: 'HTML', ...o }
      );
    });
    await sendSettingsPanel(chatId, msgId);
    return;
  }

  // Competition wizard
  if (compWizard.has(chatId)) {
    const wizard = compWizard.get(chatId);
    const data = wizard.data;
    const currentStep = wizard.step;
    
    try {
      if (currentStep === 1) {
        // Duration
        const minutes = Number(msg.text);
        if (!minutes || minutes < 1 || minutes > 1440) {
          return await safeSend(chatId, async (o) => {
            await bot.sendMessage(chatId, 
              '❌ <b>Invalid Duration</b>\n\n' +
              'Enter minutes (1-1440):\n' +
              '• <code>30</code> = 30 minutes\n' +
              '• <code>60</code> = 1 hour\n' +
              '• <code>1440</code> = 24 hours max', 
              { parse_mode: 'HTML', ...opts }
            );
          });
        }
        data.duration = minutes;
        wizard.step = 2;
        return await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            `⏳ <b>Step 2/4: Minimum Buy</b>\n\n` +
            `Duration set: <b>${minutes} minutes</b>\n\n` +
            'Enter minimum USD to qualify:\n' +
            '• <code>25</code> = $25+ buys count\n' +
            '• <code>0</code> = all buys count', 
            { parse_mode: 'HTML', ...o }
          );
        });
      }
      
      if (currentStep === 2) {
        // Min buy
        data.minBuyUsd = Number(msg.text) || 0;
        wizard.step = 3;
        return await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            `💰 <b>Step 3/4: 1st Place Prize</b>\n\n` +
            `⏳ ${data.duration}min | 💵 $${data.minBuyUsd} min\n\n` +
            'Enter prize for 🥇 1st place:\n' +
            '• <code>100 BESC</code>\n' +
            '• <code>Special shoutout</code>\n' +
            '• <code>Custom trophy</code>', 
            { parse_mode: 'HTML', ...o }
          );
        });
      }
      
      if (currentStep === 3) {
        // 1st prize
        data.prize1 = msg.text.trim();
        wizard.step = 4;
        return await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            `🥇 <b>Step 4/4: 2nd & 3rd Prizes</b>\n\n` +
            `⏳ ${data.duration}min | 💵 $${data.minBuyUsd} min\n` +
            `🥇 ${data.prize1}\n\n` +
            'Enter 2nd and 3rd prizes (comma separated):\n' +
            '<code>50 BESC, Bronze trophy</code>', 
            { parse_mode: 'HTML', ...o }
          );
        });
      }
      
      if (currentStep === 4) {
        // Final prizes
        const [p2, p3] = msg.text.split(',').map(s => s.trim()).map(s => s || '—');
        data.prizes = [data.prize1, p2, p3];
        
        const updatedCfg = await getChat(chatId);
        updatedCfg.activeCompetition = {
          endsAt: Date.now() + data.duration * 60 * 1000,
          minBuyUsd: data.minBuyUsd,
          prizes: data.prizes,
          leaderboard: {},
          startedAt: Date.now()
        };
        await setChat(chatId, updatedCfg);
        compWizard.delete(chatId);
        
        await safeSend(chatId, async (o) => {
          await bot.sendMessage(chatId, 
            `🎉 <b>BIG BUY COMPETITION STARTED!</b>\n\n` +
            `⏰ <b>Duration:</b> ${data.duration} minutes\n` +
            `💰 <b>Min Buy:</b> $${data.minBuyUsd}\n` +
            `👥 <b>Leaderboard:</b> Live updates\n\n` +
            `🏆 <b>Prizes:</b>\n` +
            `🥇 1st: ${data.prizes[0]}\n` +
            `🥈 2nd: ${data.prizes[1]}\n` +
            `🥉 3rd: ${data.prizes[2]}\n\n` +
            `🚀 Qualifying buys will appear on leaderboard!\n` +
            `📊 Check with "Leaderboard" button anytime`, 
            { 
              parse_mode: 'HTML', 
              reply_markup: { 
                inline_keyboard: [[
                  { text: '📊 View Leaderboard', callback_data: 'show_leaderboard' },
                  { text: '🛑 End Early', callback_data: 'end_comp' }
                ]] 
              }, 
              ...o 
            }
          );
        });
        await sendSettingsPanel(chatId);
        return;
      }
    } catch (e) {
      console.error('[COMP WIZARD ERROR]:', e.message);
      compWizard.delete(chatId);
    }
  }
});

// -------- UTILITY FUNCTIONS --------
async function checkBotAdminStatus(chatId) {
  try {
    const me = await bot.getMe();
    const admins = await bot.getChatAdministrators(chatId);
    return admins.some(admin => admin.user.id === me.id);
  } catch (e) {
    return false;
  }
}

async function postLeaderboard(chatId, final = false) {
  try {
    const cfg = await getChat(chatId);
    const opts = { message_thread_id: cfg.threadId || undefined };
    
    if (!cfg.activeCompetition) {
      return await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          final ? '🏁 <b>No qualifying buys!</b>\n\nCompetition ended with no entries.' : 
                 '📭 <b>No entries yet</b>\n\nWaiting for first qualifying buy...', 
          { parse_mode: 'HTML', ...o }
        );
      });
    }
    
    const leaderboard = Object.entries(cfg.activeCompetition.leaderboard || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    if (!leaderboard.length) {
      return await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          final ? '🏁 <b>No qualifying buys!</b>\n\nCompetition ended with no entries.' : 
                 '📭 <b>No entries yet</b>\n\nWaiting for first qualifying buy...', 
          { parse_mode: 'HTML', ...o }
        );
      });
    }
    
    let message = final ? 
      `🎉 <b>COMPETITION FINISHED!</b>\n\n` : 
      `📊 <b>CURRENT LEADERBOARD</b>\n\n`;
    
    leaderboard.forEach(([wallet, amount], index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}️⃣`;
      const walletShort = wallet.slice(0, 6) + '…' + wallet.slice(-4);
      message += `${medal} <code>${walletShort}</code> — <b>$${amount.toFixed(2)}</b>\n`;
    });
    
    if (final && cfg.activeCompetition.prizes?.length) {
      message += `\n🏆 <b>FINAL PRIZES:</b>\n`;
      cfg.activeCompetition.prizes.forEach((prize, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉';
        message += `${medal} ${prize || 'No prize'}\n`;
      });
    }
    
    if (!final) {
      const timeLeft = Math.max(0, Math.round((cfg.activeCompetition.endsAt - Date.now()) / 60000));
      message += `\n⏳ <i>${timeLeft} minutes remaining</i>`;
    }
    
    await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, message, { 
        parse_mode: 'HTML', 
        ...o 
      });
    });
    
  } catch (e) {
    console.error('[LEADERBOARD ERROR]:', e.message);
  }
}

// -------- COMMAND HANDLERS WITH SAFE SEND --------
bot.onText(/\/settings|\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  
  // Capture thread if provided
  if (msg.message_thread_id) {
    try {
      // Test the thread immediately
      await bot.sendMessage(chatId, '🔄 Validating topic...', { 
        message_thread_id: msg.message_thread_id 
      });
      
      cfg.threadId = msg.message_thread_id;
      cfg.validationStatus = 'needs_validation';
      await setChat(chatId, cfg);
      
      console.log(`[INFO] Captured thread ${cfg.threadId} for chat ${chatId}`);
      
      // Clean up validation message
      const updates = await bot.getUpdates({ limit: 1, offset: -1 });
      if (updates.result.length > 0) {
        const lastMsgId = updates.result[0].message.message_id;
        setTimeout(() => {
          bot.deleteMessage(chatId, lastMsgId, { 
            message_thread_id: msg.message_thread_id 
          }).catch(() => {});
        }, 2000);
      }
      
    } catch (error) {
      console.warn(`[THREAD VALIDATION] ${chatId}:`, error.message);
      cfg.threadId = null;
      cfg.validationStatus = 'invalid';
      await setChat(chatId, cfg);
      
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          '⚠️ <b>Topic Issue</b>\n\n' +
          'Could not validate this topic.\n' +
          'Please try <code>/settings</code> in main chat or different topic.', 
          { parse_mode: 'HTML', ...o }
        );
      });
      return;
    }
  } else {
    // No thread - clear it
    cfg.threadId = null;
    cfg.validationStatus = 'needs_validation';
    await setChat(chatId, cfg);
    console.log(`[INFO] Cleared thread for chat ${chatId} (no message_thread_id)`);
  }
  
  await sendSettingsPanel(chatId);
});

bot.onText(/\/resetchat/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    if (redis) await redis.del(`chat:${chatId}:config`);
    memoryStore.delete(chatId);
    
    // Also clear any pool tracking keys for this chat
    const poolKeys = redis ? await redis.keys(`pool:*:lastTradeId`) : [];
    for (const key of poolKeys) {
      await redis?.del(key);
    }
    
    await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        '🧹 <b>Chat Reset Complete</b>\n\n' +
        '• All tracking removed\n' +
        '• Settings cleared\n' +
        '• Competition stopped\n\n' +
        'Start fresh with <code>/settings</code>', 
        { parse_mode: 'HTML', ...o }
      );
    });
  } catch (e) {
    console.error('[RESET ERROR]:', e.message);
  }
});

bot.onText(/\/resetthread/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  cfg.threadId = null;
  cfg.validationStatus = 'needs_validation';
  await setChat(chatId, cfg);
  
  console.log(`[INFO] Manual thread reset for chat ${chatId}`);
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      '🔄 <b>Thread Reset</b>\n\n' +
      'Topic thread ID cleared.\n\n' +
      '💡 To set new topic:\n' +
      '1. Go to desired topic\n' +
      '2. Type <code>/settings</code>\n' +
      '3. Bot will capture it automatically', 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/resetpool (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const poolId = match[1].trim();
  
  try {
    if (redis) await redis.del(`pool:${poolId}:lastTradeId`);
    memoryStore.delete(`pool:${poolId}:lastTradeId`);
    
    await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        `✅ <b>Pool Reset</b>\n\n` +
        `Pool <code>${poolId}</code> tracking reset.\n` +
        `Next trade will trigger alert immediately.\n\n` +
        `💡 Use if you missed recent trades`, 
        { parse_mode: 'HTML', ...o }
      );
    });
  } catch (e) {
    console.error('[POOL RESET ERROR]:', e.message);
  }
});

bot.onText(/\/removegif/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  cfg.gifFileId = null;
  cfg.gifUrl = null;
  cfg.gifChatId = null;
  await setChat(chatId, cfg);
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      '🗑️ <b>GIF Removed</b>\n\n' +
      'Alerts will now use text only.\n' +
      'Add new GIF with settings panel.', 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/add (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1];
  const topPool = await fetchTopPoolForToken(token);
  const opts = { message_thread_id: msg.message_thread_id };
  
  if (!topPool) {
    return await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        `❌ <b>No Pool Found</b>\n\n` +
        `Token <code>${token}</code> has no liquidity pool on ${GECKO_NETWORK.replace('-', ' ').toUpperCase()}.\n\n` +
        `💡 Try:\n• Verify token address\n• Wait for pool creation\n• Check popular tokens`, 
        { parse_mode: 'HTML', ...o }
      );
    });
  }
  
  const cfg = await getChat(chatId);
  const alreadyTracking = cfg.pools.includes(topPool.pool);
  
  if (!alreadyTracking) {
    cfg.pools.push(topPool.pool);
    cfg.tokenSymbols[topPool.pool] = topPool.symbol;
    await setChat(chatId, cfg);
  }
  
  const chartUrl = `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${topPool.pool}`;
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      `${alreadyTracking ? '🔄' : '✅'} <b>${alreadyTracking ? 'Already' : 'Now'} Tracking ${escapeHtml(topPool.symbol)}</b>\n\n` +
      `📊 Token: <code>${token}</code>\n` +
      `🔗 Pool: <code>${topPool.pool}</code>\n` +
      `⏰ ${alreadyTracking ? 'Reset' : 'Started'}: ${new Date().toLocaleTimeString()}\n` +
      `⚡ First alert in ~1-2 seconds\n\n` +
      `💡 ${alreadyTracking ? 'Tracking resumed!' : 'You\'ll get instant buy alerts!'}\n` +
      `<i>Min buy: $${cfg.minBuyUsd}</i>`, 
      { 
        parse_mode: 'HTML', 
        reply_markup: { 
          inline_keyboard: [[
            { text: '📈 View Chart', url: chartUrl },
            { text: '⚙️ Settings', callback_data: 'back_to_settings' }
          ]] 
        }, 
        ...o 
      }
    );
  });
});

bot.onText(/\/remove (0x[a-fA-F0-9]{40})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1];
  const topPool = await fetchTopPoolForToken(token);
  const opts = { message_thread_id: msg.message_thread_id };
  
  if (!topPool) {
    return await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        '❓ <b>Token Not Found</b>\n\n' +
        `Could not resolve pool for <code>${token}</code>.\n` +
        `Use <code>/list</code> to see tracked tokens.`, 
        { parse_mode: 'HTML', ...o }
      );
    });
  }
  
  const cfg = await getChat(chatId);
  const wasTracking = cfg.pools.includes(topPool.pool);
  
  if (wasTracking) {
    cfg.pools = cfg.pools.filter(p => p !== topPool.pool);
    delete cfg.tokenSymbols[topPool.pool];
    await setChat(chatId, cfg);
    
    // Clear the pool's last trade ID so other chats aren't affected
    if (redis) await redis.del(`pool:${topPool.pool}:lastTradeId`);
    memoryStore.delete(`pool:${topPool.pool}:lastTradeId`);
  }
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      `${wasTracking ? '🛑 <b>Stopped Tracking</b>' : 'ℹ️ <b>Not Tracking</b>'} ${escapeHtml(topPool.symbol)}\n\n` +
      `📊 Token: <code>${token}</code>\n` +
      `🔗 Pool: <code>${topPool.pool}</code>\n` +
      `⏰ ${wasTracking ? 'Stopped' : 'Never started'}: ${new Date().toLocaleTimeString()}\n\n` +
      `💡 ${wasTracking ? 'No more alerts for this token.' : 'This token was not being tracked.'}\n` +
      `<i>Still tracking ${cfg.pools.length} token${cfg.pools.length !== 1 ? 's' : ''}</i>`, 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: msg.message_thread_id };
  
  if (!cfg.pools.length) {
    return await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        '📭 <b>No Tokens Tracking</b>\n\n' +
        'Start with:\n' +
        '• <code>/add 0xTokenAddress</code>\n' +
        '• <code>/settings</code> → Add Token\n\n' +
        `💡 Popular BESC tokens usually have pools on GeckoTerminal`, 
        { parse_mode: 'HTML', ...o }
      );
    });
  }
  
  const tokenList = cfg.pools.map((pool, index) => {
    const symbol = cfg.tokenSymbols[pool] || pool.slice(0,8) + '…' + pool.slice(-4);
    return `${index + 1}. <code>${pool}</code> • ${escapeHtml(symbol)}`;
  }).join('\n');
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      `📋 <b>Tracking ${cfg.pools.length} Token${cfg.pools.length !== 1 ? 's' : ''}</b>\n\n` +
      `${tokenList}\n\n` +
      `💰 Min buy threshold: <b>$${cfg.minBuyUsd}</b>\n` +
      `⚡ Next alert in ~1 second\n\n` +
      `💡 Remove with <code>/remove 0xTokenAddress</code>`, 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/minbuy (\d+(\.\d+)?)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const minBuy = Number(match[1]);
  const cfg = await getChat(chatId);
  cfg.minBuyUsd = minBuy;
  await setChat(chatId, cfg);
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      `✅ <b>Minimum Buy Updated</b>\n\n` +
      `💰 New threshold: <b>$${minBuy}</b>\n` +
      `⏰ Active immediately\n\n` +
      `💡 <i>$0 = show all buys (including dust trades)</i>\n` +
      `📊 Tracking ${cfg.pools.length} token${cfg.pools.length !== 1 ? 's' : ''}`, 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/setgif(?:\s+(https?:\/\/\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1];
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: msg.message_thread_id };
  
  if (url) {
    // URL provided
    if (url.includes('.gif') || url.includes('giphy.com')) {
      cfg.gifUrl = url;
      cfg.gifFileId = null;
      cfg.gifChatId = null;
      await setChat(chatId, cfg);
      
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          `🌐 <b>GIF URL Set</b>\n\n` +
          `🔗 <a href="${url}">GIF Link</a>\n` +
          `🎭 Universal - works in all chats!\n` +
          `⏰ Will appear on next buy alert`, 
          { parse_mode: 'HTML', disable_web_page_preview: true, ...o }
        );
      });
    } else {
      await safeSend(chatId, async (o) => {
        await bot.sendMessage(chatId, 
          '❌ <b>Invalid GIF URL</b>\n\n' +
          `URL <code>${url}</code> doesn't look like a GIF.\n\n` +
          `💡 Try:\n• Giphy links\n• Direct .gif URLs\n• Imgur GIFs`, 
          { parse_mode: 'HTML', ...o }
        );
      });
    }
  } else {
    // Prompt for file upload
    pendingGif.set(chatId, true);
    awaitingGifUrl.delete(chatId); // Clear any pending URL input
    
    await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        '📎 <b>Upload Local GIF</b>\n\n' +
        'Send animation/GIF file:\n' +
        '• Works only in <b>this chat</b>\n' +
        '• File size limit: 50MB\n\n' +
        `💡 Use <code>/setgif https://...</code> for universal GIFs`, 
        { parse_mode: 'HTML', ...o }
      );
    });
  }
});

bot.on('animation', async (msg) => {
  const chatId = msg.chat.id;
  if (!pendingGif.has(chatId)) return;
  
  const cfg = await getChat(chatId);
  cfg.gifFileId = msg.animation.file_id;
  cfg.gifUrl = null;
  cfg.gifChatId = chatId;
  await setChat(chatId, cfg);
  pendingGif.delete(chatId);
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      `✅ <b>Local GIF Saved!</b>\n\n` +
      `📎 File: ${msg.animation.file_name || 'animation.gif'}\n` +
      `🎭 Works in <b>this chat only</b>\n` +
      `⏰ Will play on next buy alert\n\n` +
      `💡 Use URL GIFs for cross-chat compatibility`, 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/emoji\s+(small|mid|large)\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const which = match[1].toLowerCase();
  const emoji = match[2].trim();
  const cfg = await getChat(chatId);
  
  if (!['small', 'mid', 'large'].includes(which)) {
    return await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        '❌ <b>Invalid Tier</b>\n\n' +
        'Usage: <code>/emoji small 🟢</code>\n' +
        '<code>/emoji mid 💎</code>\n' +
        '<code>/emoji large 🐋</code>', 
        { parse_mode: 'HTML', ...o }
      );
    });
  }
  
  cfg.emoji[which] = emoji;
  await setChat(chatId, cfg);
  
  const tierName = which === 'small' ? 'Small' : which === 'mid' ? 'Mid' : 'Whale';
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      `✅ <b>${tierName} Emoji Updated</b>\n\n` +
      `${tierName} (${cfg.tiers[which]}+ USD): ${emoji}\n` +
      `⏰ Will appear on next qualifying buy`, 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/tier\s+(small|large)\s+(\d+(\.\d+)?)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const which = match[1].toLowerCase();
  const value = Number(match[2]);
  const cfg = await getChat(chatId);
  
  if (!['small', 'large'].includes(which) || !Number.isFinite(value) || value < 0) {
    return await safeSend(chatId, async (o) => {
      await bot.sendMessage(chatId, 
        '❌ <b>Invalid Tier</b>\n\n' +
        'Usage:\n' +
        '<code>/tier small 100</code>\n' +
        '<code>/tier large 1000</code>\n\n' +
        'Amount must be valid USD value', 
        { parse_mode: 'HTML', ...o }
      );
    });
  }
  
  cfg.tiers[which] = value;
  await setChat(chatId, cfg);
  
  const tierName = which === 'small' ? 'Small' : 'Whale';
  const emoji = cfg.emoji[which];
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      `✅ <b>${tierName} Threshold Updated</b>\n\n` +
      `${tierName}: <b>$${value}</b> ${emoji}\n` +
      `⏰ Active immediately\n\n` +
      `💡 Buys ≥ $${value} will show ${emoji} emoji`, 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/showsells\s+(on|off)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const enabled = match[1].toLowerCase() === 'on';
  const cfg = await getChat(chatId);
  cfg.showSells = enabled;
  await setChat(chatId, cfg);
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, 
      `✅ <b>Sell Alerts ${enabled ? 'ENABLED' : 'DISABLED'}</b>\n\n` +
      `${enabled ? '🔴 Will show sell trades matching your min buy threshold' : '❌ Only buy alerts (recommended for positivity)'}\n` +
      `⏰ Change takes effect immediately\n\n` +
      `💡 Most communities prefer buys only`, 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const cfg = await getChat(chatId);
  const opts = { message_thread_id: msg.message_thread_id };
  
  const poolsList = cfg.pools.length ? 
    cfg.pools.map(p => `<code>${p}</code> (${cfg.tokenSymbols[p] || 'Unknown'})`).join('\n') : 
    'None';
  
  const statusText = 
    `🤖 <b>BESC Trade Bot Status</b>\n\n` +
    `🔗 <b>Network:</b> ${GECKO_NETWORK.replace('-', ' ').toUpperCase()}\n` +
    `⏱️ <b>Polling:</b> ${POLL_INTERVAL_MS}ms intervals\n` +
    `📡 <b>API:</b> GeckoTerminal v2\n` +
    `🔗 <b>Explorer:</b> ${EXPLORER_TX_URL}\n\n` +
    
    `🎯 <b>Configuration:</b>\n` +
    `👥 <b>Chat ID:</b> <code>${chatId}</code>\n` +
    `📂 <b>Thread:</b> ${cfg.threadId || 'Main chat'}\n` +
    `✅ <b>Status:</b> ${cfg.validationStatus === 'valid' ? '🟢 Active' : '🔴 Invalid'}\n` +
    `📊 <b>Pools:</b> ${cfg.pools.length}\n` +
    `💰 <b>Min Buy:</b> $${cfg.minBuyUsd}\n` +
    `🔴 <b>Show Sells:</b> ${cfg.showSells ? '✅ Yes' : '❌ No'}\n` +
    `🐋 <b>Whale:</b> $${cfg.tiers.large} ${cfg.emoji.large}\n` +
    `💎 <b>Mid:</b> $${cfg.tiers.small} ${cfg.emoji.mid}\n` +
    `🟢 <b>Small:</b> $${cfg.tiers.small / 2 || 10} ${cfg.emoji.small}\n` +
    `🎞 <b>GIF:</b> ${cfg.gifUrl ? '🌐 URL' : (cfg.gifFileId ? '📎 Local' : '❌ None')}\n` +
    `🏆 <b>Competition:</b> ${cfg.activeCompetition ? '🟢 Active' : '❌ None'}\n\n` +
    
    `📋 <b>Tracked Pools:</b>\n${poolsList}\n\n` +
    
    `💡 <b>Last Updated:</b> ${new Date().toLocaleString()}\n` +
    `🔥 <b>Total Active Pools:</b> ${poolRoundRobin.length}`;
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, statusText, { parse_mode: 'HTML', ...o });
  });
});

bot.onText(/\/ping/, async (msg) => {
  const chatId = msg.chat.id;
  const startTime = Date.now();
  
  await safeSend(chatId, async (o) => {
    const responseTime = Date.now() - startTime;
    await bot.sendMessage(chatId, 
      `🏓 <b>Pong!</b>\n\n` +
      `✅ Bot is <b>online</b> and responsive\n` +
      `⚡ Response: <b>${responseTime}ms</b>\n` +
      `🔗 Network: <b>${GECKO_NETWORK}</b>\n` +
      `📡 Polling: <b>Active</b>\n\n` +
      `💡 Bot ready for buy alerts!\n` +
      `<i>Last check: ${new Date().toLocaleTimeString()}</i>`, 
      { parse_mode: 'HTML', ...o }
    );
  });
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const opts = { message_thread_id: msg.message_thread_id };
  
  const helpText = 
    `🤖 <b>BESC HyperChain Trade Bot</b>\n\n` +
    
    `🚀 <b>Quick Setup (2 minutes):</b>\n` +
    `1️⃣ Add bot as <b>admin</b> with "Post Messages" permission\n` +
    `2️⃣ Type <code>/settings</code> in desired topic\n` +
    `3️⃣ Click ➕ Add Token → paste token address\n` +
    `4️⃣ Set min buy amount (e.g. <code>/minbuy 25</code>)\n\n` +
    
    `⚡ <b>Key Features:</b>\n` +
    `• <b>Instant</b> buy alerts (1-second polling)\n` +
    `• 🐋 Whale / 💎 Mid / 🟢 Small tier emojis\n` +
    `• 📊 Live market data (MC, liquidity, 24h %)\n` +
    `• 🎞 GIF animations on alerts\n` +
    `• 🏆 Buy competitions with leaderboards\n` +
    `• 🔗 Direct GeckoTerminal charts & explorer links\n\n` +
    
    `📋 <b>Essential Commands:</b>\n` +
    `<code>/settings</code> → Full control panel\n` +
    `<code>/add 0x...</code> → Track token\n` +
    `<code>/remove 0x...</code> → Stop tracking\n` +
    `<code>/list</code> → Show tracked tokens\n` +
    `<code>/minbuy 50</code> → Set minimum USD\n` +
    `<code>/status</code> → Detailed config\n` +
    `<code>/ping</code> → Check bot status\n\n` +
    
    `🎯 <b>Pro Tips:</b>\n` +
    `• Use <b>GIF URLs</b> (Giphy/Imgur) for cross-chat\n` +
    `• Set up in <b>dedicated topic</b> for clean alerts\n` +
    `• <code>$0 min buy</code> = see all activity\n` +
    `• Bot <b>auto-recovers</b> from permission issues\n` +
    `• <b>1-second</b> updates = never miss a buy\n\n` +
    
    `🔧 <b>Troubleshooting:</b>\n` +
    `❌ No alerts? Check <code>/status</code>\n` +
    `❌ GIFs broken? Use URL instead of file\n` +
    `❌ Wrong topic? <code>/resetthread</code>\n` +
    `❌ Full reset? <code>/resetchat</code>\n\n` +
    
    `🌟 <b>Built for BESC HyperChain</b>\n` +
    `Fast • Reliable • Community-First\n` +
    `<i>Lightning-fast alerts for your tokens</i>`;
  
  await safeSend(chatId, async (o) => {
    await bot.sendMessage(chatId, helpText, { parse_mode: 'HTML', ...o });
  });
});

// -------- AUTO-COMPETITION CLEANUP --------
setInterval(async () => {
  try {
    const keys = redis ? await redis.keys('chat:*:config') : [...memoryStore.keys()].map(k => `chat:${k}:config`);
    
    for (const k of keys) {
      const chatId = Number(k.split(':')[1]);
      try {
        const cfg = redis ? JSON.parse(await redis.get(k)) : memoryStore.get(chatId);
        if (cfg?.activeCompetition && Date.now() >= cfg.activeCompetition.endsAt) {
          await postLeaderboard(chatId, true);
          cfg.activeCompetition = null;
          await setChat(chatId, cfg);
          console.log(`[COMP END] Chat ${chatId} competition expired`);
        }
      } catch (e) {
        // Silent fail
      }
    }
  } catch (e) {
    console.error('[COMP CLEANUP ERROR]:', e.message);
  }
}, 60000); // Check every minute

// -------- INITIALIZATION & LOGGING --------
console.log('🚀 BESC HyperChain Trade Bot - LIGHTNING EDITION');
console.log(`📡 Network: ${GECKO_NETWORK.toUpperCase()}`);
console.log(`⚡ Polling: ${POLL_INTERVAL_MS}ms (${60*1000/Number(POLL_INTERVAL_MS)} checks/min)`);
console.log(`🔗 Explorer: ${EXPLORER_TX_URL}`);
console.log(`🗄️ Storage: ${redis ? 'Redis' : 'Memory'}`);
console.log(`📢 Ready for instant buy alerts!`);
console.log(`💡 Initial pool scan in 15 seconds...`);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down gracefully...');
  if (redis) await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 Interrupt received, shutting down...');
  if (redis) await redis.quit();
  process.exit(0);
});
