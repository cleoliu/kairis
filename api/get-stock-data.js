// Vercel Serverless Function with KV Caching
// 檔案路徑: /api/get-stock-data.js
// 需要在 Vercel 專案中連結 Vercel KV 儲存體

import { kv } from '@vercel/kv';

// 全局變數來追蹤正在進行的請求
const pendingRequests = new Map();

// 追蹤 API key 狀態
const apiKeyStatus = {
  polygon: { working: true, lastError: null, lastUsed: null },
  yfinance: { working: true, lastError: null, lastUsed: null },
  twelveData: {
    primary: { working: true, lastError: null, lastUsed: null },
    backup: { working: true, lastError: null, lastUsed: null }
  }
};

// Polygon.io 數據獲取函數 - 主要數據源（速度快）
async function getPolygonData(cleanSymbol, timeframe, apiKey) {
  try {
    console.log(`[${new Date().toISOString()}] Using Polygon.io API for ${cleanSymbol}, timeframe=${timeframe}`);
    
    let apiUrl;
    if (timeframe === '5M') {
      // 5分線：使用 intraday aggregates
      const today = new Date();
      const fiveDaysAgo = new Date(today.getTime() - (5 * 24 * 60 * 60 * 1000));
      const fromDate = fiveDaysAgo.toISOString().split('T')[0];
      const toDate = today.toISOString().split('T')[0];
      apiUrl = `https://api.polygon.io/v2/aggs/ticker/${cleanSymbol}/range/5/minute/${fromDate}/${toDate}?adjusted=true&sort=asc&apiKey=${apiKey}`;
    } else {
      // 日線：最近90天
      const today = new Date();
      const ninetyDaysAgo = new Date(today.getTime() - (90 * 24 * 60 * 60 * 1000));
      const fromDate = ninetyDaysAgo.toISOString().split('T')[0];
      const toDate = today.toISOString().split('T')[0];
      apiUrl = `https://api.polygon.io/v2/aggs/ticker/${cleanSymbol}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&apiKey=${apiKey}`;
    }
    
    console.log(`[${new Date().toISOString()}] Fetching from Polygon.io: ${apiUrl}`);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Polygon.io API HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // 檢查回應狀態
    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      console.error('Invalid Polygon.io response:', data);
      throw new Error(data.status === 'ERROR' ? `Polygon.io error: ${data.error}` : 'No data available');
    }
    
    // 轉換資料格式
    const history = data.results.map(item => {
      const date = new Date(item.t);
      const dateString = timeframe === '5M' 
        ? date.toISOString() 
        : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
      
      return {
        date: dateString,
        open: item.o,
        high: item.h,
        low: item.l,
        close: item.c,
        volume: item.v || 0
      };
    });
    
    console.log(`[${new Date().toISOString()}] ✅ Polygon.io success: ${history.length} data points for ${cleanSymbol}`);
    
    // 更新成功狀態
    apiKeyStatus.polygon.working = true;
    apiKeyStatus.polygon.lastError = null;
    apiKeyStatus.polygon.lastUsed = new Date().toISOString();
    
    return {
      symbol: cleanSymbol,
      name: cleanSymbol,
      history: history,
      source: 'polygon',
      timeframe: timeframe,
      total_points: history.length
    };
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Polygon.io API failed for ${cleanSymbol}:`, error.message);
    
    // 更新錯誤狀態
    apiKeyStatus.polygon.working = false;
    apiKeyStatus.polygon.lastError = error.message;
    apiKeyStatus.polygon.lastUsed = new Date().toISOString();
    
    return null;
  }
}

// Polygon.io Grouped Daily API - 批量獲取所有股票當日數據
async function getPolygonGroupedDaily(apiKey, date = null) {
  try {
    // 如果沒有指定日期，使用昨天（因為當天數據可能還不完整）
    const targetDate = date || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const apiUrl = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${targetDate}?adjusted=true&apiKey=${apiKey}`;
    
    console.log(`[${new Date().toISOString()}] Fetching grouped daily data from Polygon.io for ${targetDate}`);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Polygon.io Grouped API HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.status !== 'OK' || !data.results) {
      throw new Error('No grouped data available');
    }
    
    // 將結果轉換為 symbol -> data 的 Map
    const stockMap = new Map();
    data.results.forEach(item => {
      stockMap.set(item.T, {
        date: targetDate,
        open: item.o,
        high: item.h,
        low: item.l,
        close: item.c,
        volume: item.v || 0
      });
    });
    
    console.log(`[${new Date().toISOString()}] ✅ Polygon.io grouped daily: ${stockMap.size} stocks`);
    
    return stockMap;
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Polygon.io Grouped API failed:`, error.message);
    return null;
  }
}

// yfinance 數據獲取函數 - 備用數據源
async function getYfinanceData(cleanSymbol, timeframe) {
  try {
    console.log(`[${new Date().toISOString()}] Using Yahoo Finance official API for ${cleanSymbol}, timeframe=${timeframe}`);
    
    // 🔧 設定明確的時間範圍 - 確保取得最新資料
    let apiUrl;
    if (timeframe === '5M') {
      // 5分線：最近5天
      const now = Math.floor(Date.now() / 1000);
      const fiveDaysAgo = now - (5 * 24 * 60 * 60);
      apiUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanSymbol}?period1=${fiveDaysAgo}&period2=${now}&interval=5m&includePrePost=true&includeAdjustedClose=true`;
    } else {
      // 日線：最近3個月 (90天) - 確保有足夠數據計算完整的MACD  
      const now = Math.floor(Date.now() / 1000);
      const threeMonthsAgo = now - (90 * 24 * 60 * 60); // 90天確保有充足的MACD計算數據
      apiUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanSymbol}?period1=${threeMonthsAgo}&period2=${now}&interval=1d&includePrePost=true&includeAdjustedClose=true`;
    }
    
    console.log(`[${new Date().toISOString()}] Fetching from Yahoo Finance: ${apiUrl}`);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Yahoo Finance API HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // 檢查回應結構
    if (!data.chart || !data.chart.result || !data.chart.result[0]) {
      console.error('Invalid Yahoo Finance response:', data);
      throw new Error('Invalid response structure from Yahoo Finance API');
    }
    
    const result = data.chart.result[0];
    
    // 檢查是否有錯誤
    if (data.chart.error) {
      throw new Error(`Yahoo Finance API error: ${data.chart.error.description}`);
    }
    
    const timestamps = result.timestamp;
    const quotes = result.indicators?.quote?.[0];
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose;
    
    if (!timestamps || !quotes || timestamps.length === 0) {
      console.error('No data in Yahoo Finance response');
      throw new Error('No historical data found');
    }
    
    // 轉換資料格式
    const history = [];
    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const open = quotes.open?.[i];
      const high = quotes.high?.[i];
      const low = quotes.low?.[i];
      const close = adjClose?.[i] || quotes.close?.[i]; // 使用調整後收盤價
      const volume = quotes.volume?.[i];
      
      // 跳過無效資料
      if (close === null || close === undefined || isNaN(close)) {
        continue;
      }
      
      const date = new Date(timestamp * 1000);
      
      // 🔧 修正日期格式 - 使用 UTC 避免時區問題
      const dateString = timeframe === '5M' 
        ? date.toISOString() 
        : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
      
      history.push({
        date: dateString,
        open: open || close,
        high: high || close,
        low: low || close,
        close: close,
        volume: volume || 0
      });
    }
    
    // 按日期排序 (最新在後)
    if (timeframe !== '5M') {
      history.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    
    console.log(`[${new Date().toISOString()}] ✅ Yahoo Finance success: ${history.length} data points for ${cleanSymbol}`);
    
    // 獲取股票名稱
    const stockName = result.meta?.longName || result.meta?.shortName || cleanSymbol;
    
    return {
      symbol: cleanSymbol,
      name: stockName,
      history: history,
      source: 'yahoo-finance',
      timeframe: timeframe,
      total_points: history.length
    };
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Yahoo Finance API failed for ${cleanSymbol}:`, error.message);
    return null;
  }
}

// Rate limit 控制
// Twelve Data 免費版限制：8 requests/minute (每分鐘8次請求)
// 為了安全起見，我們設置最小間隔為8秒，確保不超過限制
const rateLimitControl = {
  twelveData: {
    primary: {
      lastRequest: 0,
      requestCount: 0,
      resetTime: 0,
      minInterval: 8000, // 最小間隔 8 秒 (7.5 requests/minute, 安全起見)
      isRateLimited: false,
      rateLimitResetTime: 0
    },
    backup: {
      lastRequest: 0,
      requestCount: 0,
      resetTime: 0,
      minInterval: 8000, // 最小間隔 8 秒
      isRateLimited: false,
      rateLimitResetTime: 0
    }
  }
};

// 輔助函數：檢查是否可以發起請求
function canMakeRequest(keyType) {
  const now = Date.now();
  const control = rateLimitControl.twelveData[keyType];
  
  // 如果處於 rate limit 狀態，檢查是否已過期
  if (control.isRateLimited && now > control.rateLimitResetTime) {
    control.isRateLimited = false;
    console.log(`[${new Date().toISOString()}] Rate limit expired for Twelve Data ${keyType} key`);
  }
  
  // 如果仍在 rate limit 中，不能發起請求
  if (control.isRateLimited) {
    const remainingTime = Math.ceil((control.rateLimitResetTime - now) / 1000);
    console.warn(`[${new Date().toISOString()}] Twelve Data ${keyType} key is rate limited for ${remainingTime} seconds`);
    return false;
  }
  
  // 檢查最小間隔
  const timeSinceLastRequest = now - control.lastRequest;
  if (timeSinceLastRequest < control.minInterval) {
    const waitTime = control.minInterval - timeSinceLastRequest;
    console.log(`[${new Date().toISOString()}] Need to wait ${waitTime}ms before next Twelve Data ${keyType} request`);
    return false;
  }
  
  return true;
}

// 輔助函數：更新請求記錄
function recordRequest(keyType) {
  const now = Date.now();
  const control = rateLimitControl.twelveData[keyType];
  control.lastRequest = now;
  control.requestCount++;
}

export default async function handler(request, response) {
  // 支持從 query 或 body 讀取 action
  const action = request.query?.action || request.body?.action;

  if (request.method === 'GET') {
    if (action === 'get_news') {
      return handleGetNews(request, response);
    } else if (action === 'api_status') {
      return handleApiStatus(request, response);
    } else if (action === 'warmup_cache') {
      return handleWarmupCache(request, response);
    }
    return handleGetStockData(request, response);
  } else if (request.method === 'POST') {
    // POST 支持 warmup_cache 或 Gemini 分析
    if (action === 'warmup_cache') {
      return handleWarmupCache(request, response);
    }
    return handleGeminiAnalysis(request, response);
  } else {
    response.setHeader('Allow', ['GET', 'POST']);
    return response.status(405).end(`Method ${request.method} Not Allowed`);
  }
}

// 處理緩存預熱請求 - 供 n8n 每日定時調用
async function handleWarmupCache(request, response) {
  try {
    // 支持 GET (query params) 和 POST (JSON body) 兩種方式
    let symbols, secret;
    
    if (request.method === 'POST') {
      symbols = request.body?.symbols;
      secret = request.body?.secret;
    } else {
      symbols = request.query?.symbols;
      secret = request.query?.secret;
    }
    
    // 驗證密鑰
    const expectedSecret = process.env.WARMUP_SECRET || 'change-me-in-production';
    if (secret !== expectedSecret) {
      console.error(`[${new Date().toISOString()}] Auth failed: expected="${expectedSecret}", received="${secret}"`);
      return response.status(401).json({ error: '未授權的請求' });
    }
    
    if (!symbols) {
      return response.status(400).json({ error: '必須提供 symbols 參數' });
    }
    
    const polygonApiKey = process.env.POLYGON_API_KEY;
    const finnhubApiKey = process.env.FINNHUB_API_KEY;
    
    if (!polygonApiKey && !finnhubApiKey) {
      return response.status(500).json({ error: 'API keys 未設定' });
    }
    
    const symbolList = symbols.split(',').map(s => s.trim());
    console.log(`[${new Date().toISOString()}] 🔥 Warmup cache request for ${symbolList.length} symbols`);
    
    const results = {
      success: [],
      failed: [],
      total: symbolList.length
    };
    
    // 批次處理，每批 2 個股票（降低並發避免 rate limit）
    const BATCH_SIZE = 2;
    for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
      const batch = symbolList.slice(i, i + BATCH_SIZE);
      
      await Promise.allSettled(
        batch.map(async (symbol) => {
          const maxRetries = 3;
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              const cleanSymbol = symbol.replace(/\.US$/, '');
              const today = new Date().toISOString().split('T')[0];
              
              console.log(`[${new Date().toISOString()}] 📊 Warmup ${symbol} (attempt ${attempt}/${maxRetries})...`);
              
              // 檢查並等待 rate limit
              await waitForRateLimit();
              
              // 在重試前額外等待
              if (attempt > 1) {
                const retryWaitTime = attempt * 5000;
                console.log(`[${new Date().toISOString()}] Waiting ${retryWaitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, retryWaitTime));
              }
              
              // 獲取歷史數據（日線）
              console.log(`[${new Date().toISOString()}] Calling fetchHistoricalData for ${cleanSymbol}...`);
              const historyResult = await fetchHistoricalData(cleanSymbol, null, finnhubApiKey, polygonApiKey);
              
              if (historyResult?.data && Array.isArray(historyResult.data) && historyResult.data.length > 0) {
                // 緩存歷史數據
                const historyCacheKey = `global_history_${symbol}_${today}`;
                const cacheTime = 86400 * 7; // 7天
                
                await kv.set(historyCacheKey, historyResult.data, { ex: cacheTime });
                
                console.log(`[${new Date().toISOString()}] ✅ Cached ${symbol}: ${historyResult.data.length} data points`);
                results.success.push(symbol);
                return;
              } else {
                throw new Error('No data returned from fetchHistoricalData');
              }
            } catch (error) {
              const errorDetail = error.message || error.toString();
              console.error(`[${new Date().toISOString()}] ❌ Attempt ${attempt}/${maxRetries} failed for ${symbol}:`, errorDetail);
              
              // 檢查是否是 rate limit 錯誤
              const isRateLimitError = errorDetail.includes('Rate limit') || 
                                       errorDetail.includes('429') || 
                                       errorDetail.includes('rate limited');
              
              if (attempt === maxRetries) {
                console.error(`[${new Date().toISOString()}] All retries exhausted for ${symbol}`);
                results.failed.push({ symbol, error: errorDetail });
              } else if (isRateLimitError) {
                const extraWait = 15000;
                console.log(`[${new Date().toISOString()}] 🔄 Rate limit error detected, waiting extra ${extraWait}ms...`);
                await new Promise(resolve => setTimeout(resolve, extraWait));
              }
            }
          }
        })
      );
      
      // 避免 API rate limit，批次之間等待
      if (i + BATCH_SIZE < symbolList.length) {
        console.log(`[${new Date().toISOString()}] Waiting 15s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
    }
    
    console.log(`[${new Date().toISOString()}] 🎉 Warmup completed: ${results.success.length}/${results.total} successful`);
    
    return response.status(200).json({
      success: true,
      message: 'Cache warmup completed',
      results
    });
    
  } catch (error) {
    console.error('handleWarmupCache Error:', error);
    return response.status(500).json({ 
      error: '緩存預熱時發生錯誤',
      details: error.message 
    });
  }
}

// 輔助函數：等待 rate limit 解除
async function waitForRateLimit() {
  // 如果使用 Polygon.io，等待足夠時間
  const now = Date.now();
  const minInterval = 12000; // 12秒間隔確保不超過 5 requests/minute
  
  // 簡單的全局 rate limit 控制
  if (!globalThis.lastPolygonRequest) {
    globalThis.lastPolygonRequest = 0;
  }
  
  const timeSinceLastRequest = now - globalThis.lastPolygonRequest;
  if (timeSinceLastRequest < minInterval) {
    const waitTime = minInterval - timeSinceLastRequest;
    console.log(`[${new Date().toISOString()}] ⏳ Waiting ${waitTime}ms for rate limit...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  globalThis.lastPolygonRequest = Date.now();
}

// 獲取歷史數據的獨立函數 - 優先使用 Polygon.io，備用 yfinance
async function fetchHistoricalData(cleanSymbol, timeframe, finnhubApiKey, polygonApiKey) {
  console.log(`[${new Date().toISOString()}] Fetching historical data for ${cleanSymbol}`);
  
  let historyData = null;
  let cacheTime = timeframe === '5M' ? 3600 : 86400 * 7;
  
  // 優先使用 Polygon.io
  if (polygonApiKey) {
    try {
      const polygonResult = await getPolygonData(cleanSymbol, timeframe, polygonApiKey);
      
      if (polygonResult && polygonResult.history && Array.isArray(polygonResult.history) && polygonResult.history.length > 0) {
        historyData = polygonResult.history;
        console.log(`[${new Date().toISOString()}] ✅ Polygon.io success: ${historyData.length} data points for ${cleanSymbol}`);
        return { data: historyData, cacheTime };
      }
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Polygon.io failed for ${cleanSymbol}, trying fallback:`, error.message);
    }
  }
  
  // 備用：使用 yfinance
  try {
    const yfinanceResult = await getYfinanceData(cleanSymbol, timeframe);
    
    if (yfinanceResult && yfinanceResult.history && Array.isArray(yfinanceResult.history) && yfinanceResult.history.length > 0) {
      historyData = yfinanceResult.history;
      
      // 更新 yfinance 成功狀態
      apiKeyStatus.yfinance.working = true;
      apiKeyStatus.yfinance.lastError = null;
      apiKeyStatus.yfinance.lastUsed = new Date().toISOString();
      
      console.log(`[${new Date().toISOString()}] ✅ yfinance fallback success: ${historyData.length} data points for ${cleanSymbol}`);
      return { data: historyData, cacheTime };
    } else {
      throw new Error('yfinance returned empty data');
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ All data sources failed for ${cleanSymbol}:`, error.message);
    
    // 更新 yfinance 錯誤狀態
    apiKeyStatus.yfinance.working = false;
    apiKeyStatus.yfinance.lastError = error.message;
    apiKeyStatus.yfinance.lastUsed = new Date().toISOString();
    
    throw new Error(`無法獲取 ${cleanSymbol} 的歷史資料: ${error.message}`);
  }

  // 移除所有其他資料來源 (Twelve Data)
  if (false) {
    console.log(`[${new Date().toISOString()}] Trying Twelve Data API for ${cleanSymbol}`);
    
    const twelveDataKeys = [
      { key: process.env.TWELVE_DATA_API_KEY, type: 'primary' },
      { key: process.env.TWELVE_DATA_BACKUP_API_KEY, type: 'backup' }
    ].filter(item => item.key);

    for (const { key: apiKey, type: keyType } of twelveDataKeys) {
      if (historyData) break;

      try {
        // 檢查是否可以發起請求（rate limit 控制）
        if (canMakeRequest(keyType)) {
          // 等待必要的間隔時間
          const control = rateLimitControl.twelveData[keyType];
          const waitTime = control.isRateLimited 
            ? Math.max(0, control.rateLimitResetTime - Date.now())
            : Math.max(0, (control.lastRequest + control.minInterval) - Date.now());

          if (waitTime > 0) {
            if (waitTime <= 10000) { // 最多等待10秒
              console.log(`[${new Date().toISOString()}] Waiting ${waitTime}ms for Twelve Data ${keyType} key rate limit`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              
              // 重新檢查是否可以發請求
              if (!canMakeRequest(keyType)) {
                console.warn(`[${new Date().toISOString()}] Still rate limited after waiting, skipping Twelve Data ${keyType} key`);
                continue;
              }
            } else {
              console.warn(`[${new Date().toISOString()}] Rate limit wait time too long (${waitTime}ms), skipping Twelve Data ${keyType} key`);
              continue;
            }
          }
        } else {
          console.log(`[${new Date().toISOString()}] Skipping rate limited Twelve Data ${keyType} key, trying next`);
          continue;
        }

        // 記錄請求
        recordRequest(keyType);
        
        const twelveDataUrl = `https://api.twelvedata.com/time_series?symbol=${cleanSymbol}&interval=1day&outputsize=5000&apikey=${apiKey}`;
        const twelveResponse = await fetch(twelveDataUrl);
        
        if (twelveResponse.ok) {
          const twelveJson = await twelveResponse.json();
          
          // 檢查是否有錯誤響應（API 配額用完等）
          if (twelveJson.code || twelveJson.status === 'error') {
            // 檢查是否是 rate limit 錯誤
            if (twelveJson.code === 429 || twelveJson.message.toLowerCase().includes('rate limit') || 
                twelveJson.message.toLowerCase().includes('quota') || twelveJson.message.toLowerCase().includes('limit exceeded')) {
              console.warn(`[${new Date().toISOString()}] Rate limit detected for Twelve Data ${keyType} key`);
              
              // 設置 rate limit 狀態
              const control = rateLimitControl.twelveData[keyType];
              control.isRateLimited = true;
              control.rateLimitResetTime = Date.now() + (60 * 60 * 1000);
              
              apiKeyStatus.twelveData[keyType].lastError = `Rate Limited: ${twelveJson.message}`;
              continue; // 嘗試下一個 API key
            } else {
              console.warn(`[${new Date().toISOString()}] Twelve Data ${keyType} key API error:`, twelveJson.message || twelveJson.code);
              apiKeyStatus.twelveData[keyType].lastError = `API Error: ${twelveJson.message || twelveJson.code}`;
              continue; // 嘗試下一個 API key
            }
          }

          if (twelveJson.values && Array.isArray(twelveJson.values) && twelveJson.values.length > 0) {
            // 轉換 Twelve Data 格式到標準格式
            historyData = twelveJson.values.map(item => ({
              date: item.datetime,
              open: parseFloat(item.open),
              high: parseFloat(item.high),
              low: parseFloat(item.low),
              close: parseFloat(item.close),
              volume: parseInt(item.volume) || 0
            }));
            
            cacheTime = 86400 * 7; // 7天快取
            console.log(`[${new Date().toISOString()}] Successfully used Twelve Data ${keyType} key:`, historyData.length, 'points');
            
            // 更新成功狀態
            apiKeyStatus.twelveData[keyType].working = true;
            apiKeyStatus.twelveData[keyType].lastError = null;
            
            // 記錄響應頭信息
            console.log(`[${new Date().toISOString()}] Twelve Data ${keyType} response headers:`, {
              'x-ratelimit-remaining': twelveResponse.headers.get('x-ratelimit-remaining'),
              'x-ratelimit-reset': twelveResponse.headers.get('x-ratelimit-reset')
            });
            break; // 成功獲取數據，退出循環
          } else {
            console.warn(`[${new Date().toISOString()}] Twelve Data ${keyType} key returned no data for ${cleanSymbol}`);
            apiKeyStatus.twelveData[keyType].lastError = 'No data returned';
          }
        } else {
          // 檢查是否是 rate limit HTTP 錯誤
          if (twelveResponse.status === 429) {
            console.warn(`[${new Date().toISOString()}] HTTP 429 Rate limit detected for Twelve Data ${keyType} key`);
            
            // 設置 rate limit 狀態
            const control = rateLimitControl.twelveData[keyType];
            control.isRateLimited = true;
            
            const resetHeader = twelveResponse.headers.get('x-ratelimit-reset');
            if (resetHeader) {
              control.rateLimitResetTime = parseInt(resetHeader) * 1000; // 轉換為毫秒
            } else {
              control.rateLimitResetTime = Date.now() + (60 * 60 * 1000);
            }
            
            apiKeyStatus.twelveData[keyType].lastError = `HTTP 429: Rate Limited`;
            continue;
          } else {
            console.warn(`[${new Date().toISOString()}] Twelve Data ${keyType} key HTTP error:`, twelveResponse.status, twelveResponse.statusText);
            apiKeyStatus.twelveData[keyType].lastError = `HTTP ${twelveResponse.status}: ${twelveResponse.statusText}`;
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Twelve Data ${keyType} key error:`, error.message);
        apiKeyStatus.twelveData[keyType].lastError = error.message;
      }
    }
  }

  // 不使用 Finnhub 作為備用，只使用 yfinance
  if (false && !historyData) {
    if (timeframe === '5M') {
      // 5分線數據 - 使用 Finnhub 作為最後備用
      cacheTime = 3600; // 快取 1 小時
      
      console.log(`[${new Date().toISOString()}] Trying Finnhub as final fallback for 5min data: ${cleanSymbol}`);
      
      // 使用Finnhub的分時數據作為最後備用選項
      const intradayUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${cleanSymbol}&resolution=5&from=${Math.floor(Date.now()/1000) - (5 * 86400)}&to=${Math.floor(Date.now()/1000)}&token=${finnhubApiKey}`;
      
      try {
        const intradayResponse = await fetch(intradayUrl);
        if (intradayResponse.ok) {
          const intradayJson = await intradayResponse.json();
          
          if (intradayJson.s === 'ok' && intradayJson.c?.length > 0) {
            console.log(`[${new Date().toISOString()}] Using Finnhub intraday data as final fallback:`, intradayJson.c.length, 'points');
            
            historyData = intradayJson.c.map((close, i) => ({
              date: new Date(intradayJson.t[i] * 1000).toISOString(),
              open: intradayJson.o[i],
              high: intradayJson.h[i],
              low: intradayJson.l[i],
              close: close,
              volume: intradayJson.v[i]
            })).slice(-78); // 最多78個5分鐘K線
          } else {
            console.warn(`[${new Date().toISOString()}] No intraday data available for ${cleanSymbol}`);
            throw new Error(`找不到 ${cleanSymbol} 的5分線資料，可能此股票不支援分時數據`);
          }
        } else {
          console.warn(`[${new Date().toISOString()}] Finnhub intraday API request failed for ${cleanSymbol}, status: ${intradayResponse.status}`);
          throw new Error(`從 Finnhub 獲取分時資料失敗: ${cleanSymbol}`);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Finnhub intraday fetch error:`, error);
        throw new Error(`獲取5分線資料時發生錯誤: ${cleanSymbol}`);
      }
    } else {
      // 日線數據 - 使用 Finnhub 作為最後備用
      cacheTime = 86400 * 7; // 快取 7 天
      
      console.log(`[${new Date().toISOString()}] Trying Finnhub as final fallback for daily data: ${cleanSymbol}`);
      
      try {
        const finnhubHistoryUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${cleanSymbol}&resolution=D&from=${Math.floor(Date.now()/1000) - (730 * 24 * 60 * 60)}&to=${Math.floor(Date.now()/1000)}&token=${finnhubApiKey}`;
        const finnhubResponse = await fetch(finnhubHistoryUrl);
        
        if (finnhubResponse.ok) {
          const finnhubJson = await finnhubResponse.json();
          
          console.log(`[${new Date().toISOString()}] Finnhub response for ${cleanSymbol}:`, {
            status: finnhubJson.s,
            dataLength: finnhubJson.c?.length,
            hasClose: !!finnhubJson.c,
            hasOpen: !!finnhubJson.o,
            hasHigh: !!finnhubJson.h,
            hasLow: !!finnhubJson.l,
            hasVolume: !!finnhubJson.v,
            hasTime: !!finnhubJson.t
          });
          
          if (finnhubJson.s === 'ok' && finnhubJson.c?.length > 0) {
            historyData = finnhubJson.c.map((close, i) => ({
              date: new Date(finnhubJson.t[i] * 1000).toISOString().split('T')[0],
              open: finnhubJson.o[i],
              high: finnhubJson.h[i],
              low: finnhubJson.l[i],
              close: close,
              volume: finnhubJson.v[i]
            })).reverse(); // Finnhub返回的數據是倒序的
            
            console.log(`[${new Date().toISOString()}] Successfully using Finnhub daily data as final fallback for ${cleanSymbol}:`, historyData.length, 'points');
          } else {
            console.warn(`[${new Date().toISOString()}] Finnhub returned invalid data for ${cleanSymbol}:`, {
              status: finnhubJson.s,
              message: finnhubJson.s !== 'ok' ? 'API returned error status' : 'No data points available'
            });
          }
        } else {
          console.warn(`[${new Date().toISOString()}] Finnhub HTTP error for ${cleanSymbol}:`, finnhubResponse.status, finnhubResponse.statusText);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Finnhub daily fetch error for ${cleanSymbol}:`, error);
      }
      
      if (!historyData) {
        console.warn(`No historical data found for ${cleanSymbol}, will create placeholder data`);
        throw new Error(`找不到 ${cleanSymbol} 的歷史資料`);
      }
    }
  }

  return { data: historyData, cacheTime };
}

// 處理 API 狀態查詢
async function handleApiStatus(_, response) {
  try {
    const statusReport = {
      timestamp: new Date().toISOString(),
      environment: {
        POLYGON_API_KEY: !!process.env.POLYGON_API_KEY,
        YFINANCE_AVAILABLE: true, // yfinance 不需要 API key
        FINNHUB_API_KEY: !!process.env.FINNHUB_API_KEY,
        TWELVE_DATA_API_KEY: !!process.env.TWELVE_DATA_API_KEY,
        TWELVE_DATA_API_KEY_BACKUP: !!process.env.TWELVE_DATA_API_KEY_BACKUP,
        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
        KV_CONFIGURED: !!(process.env.KV_URL && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
      },
      apiStatus: apiKeyStatus,
      rateLimitStatus: {
        twelveData: {
          primary: {
            ...rateLimitControl.twelveData.primary,
            canMakeRequest: canMakeRequest('primary'),
            nextAvailableTime: rateLimitControl.twelveData.primary.isRateLimited 
              ? new Date(rateLimitControl.twelveData.primary.rateLimitResetTime).toISOString()
              : new Date(rateLimitControl.twelveData.primary.lastRequest + rateLimitControl.twelveData.primary.minInterval).toISOString()
          },
          backup: {
            ...rateLimitControl.twelveData.backup,
            canMakeRequest: canMakeRequest('backup'),
            nextAvailableTime: rateLimitControl.twelveData.backup.isRateLimited 
              ? new Date(rateLimitControl.twelveData.backup.rateLimitResetTime).toISOString()
              : new Date(rateLimitControl.twelveData.backup.lastRequest + rateLimitControl.twelveData.backup.minInterval).toISOString()
          }
        }
      },
      pendingRequests: pendingRequests.size
    };

    return response.status(200).json(statusReport);
  } catch (error) {
    console.error('handleApiStatus Error:', error);
    return response.status(500).json({ 
      error: '獲取 API 狀態時發生錯誤',
      details: error.message 
    });
  }
}

// 處理從 Finnhub (即時) 和 FMP (歷史) 獲取股價資料的邏輯
async function handleGetStockData(request, response) {
  let symbol, timeframe; // 在 try 外部宣告變數
  try {
    ({ symbol, timeframe } = request.query);
    if (!symbol) {
      return response.status(400).json({ error: '必須提供股票代號' });
    }

    // 只支援美股，拒絕台股請求
    if (symbol.includes('.TW')) {
      return response.status(400).json({ error: '目前暫不支援台股查詢' });
    }

    // Log environment for debugging
    console.log('Environment check:', {
      POLYGON_API_KEY: !!process.env.POLYGON_API_KEY,
      FINNHUB_API_KEY: !!process.env.FINNHUB_API_KEY,
      TWELVE_DATA_API_KEY: !!process.env.TWELVE_DATA_API_KEY,
      TWELVE_DATA_API_KEY_BACKUP: !!process.env.TWELVE_DATA_API_KEY_BACKUP,
      KV_URL: !!process.env.KV_URL,
      KV_REST_API_URL: !!process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN
    });

    // Log current API key status
    console.log('Current API Key Status:', JSON.stringify(apiKeyStatus, null, 2));
    
    // Log current rate limit status
    console.log('Current Rate Limit Status:', {
      twelveData: {
        primary: {
          canMakeRequest: canMakeRequest('primary'),
          isRateLimited: rateLimitControl.twelveData.primary.isRateLimited,
          requestCount: rateLimitControl.twelveData.primary.requestCount,
          lastRequest: rateLimitControl.twelveData.primary.lastRequest ? new Date(rateLimitControl.twelveData.primary.lastRequest).toISOString() : null
        },
        backup: {
          canMakeRequest: canMakeRequest('backup'),
          isRateLimited: rateLimitControl.twelveData.backup.isRateLimited,
          requestCount: rateLimitControl.twelveData.backup.requestCount,
          lastRequest: rateLimitControl.twelveData.backup.lastRequest ? new Date(rateLimitControl.twelveData.backup.lastRequest).toISOString() : null
        }
      }
    });

    const finnhubApiKey = process.env.FINNHUB_API_KEY;
    const polygonApiKey = process.env.POLYGON_API_KEY;

    if (!finnhubApiKey) {
      return response.status(500).json({ error: 'FINNHUB_API_KEY 未設定' });
    }
    
    if (!polygonApiKey) {
      console.warn('POLYGON_API_KEY not set, will use yfinance as fallback');
    }

    // 獲取當前日期字符串 (YYYY-MM-DD)
    const today = new Date().toISOString().split('T')[0];
    
    const quoteCacheKey = `quote_finnhub_${symbol}`;
    // 歷史數據使用全局共用的快取鍵，包含日期
    const historyCacheKey = timeframe === '5M' ? 
      `global_intraday_${symbol}_${today}` : 
      `global_history_${symbol}_${today}`;
    
    // 檢查是否為週末（美股市場關閉）
    const todayDate = new Date();
    const dayOfWeek = todayDate.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6; // 0=週日, 6=週六
    
    // 如果是週末，使用上一個交易日的數據
    let tradingDay = today;
    let historyData = null; // 初始化歷史數據變數
    
    if (isWeekend) {
      const lastTradingDate = new Date(todayDate);
      if (dayOfWeek === 0) { // 週日，回到週五
        lastTradingDate.setDate(lastTradingDate.getDate() - 2);
      } else { // 週六，回到週五
        lastTradingDate.setDate(lastTradingDate.getDate() - 1);
      }
      tradingDay = lastTradingDate.toISOString().split('T')[0];
      
      // 週末時使用上一交易日的快取
      const weekendHistoryCacheKey = timeframe === '5M' ? 
        `global_intraday_${symbol}_${tradingDay}` : 
        `global_history_${symbol}_${tradingDay}`;
      
      try {
        const weekendData = await kv.get(weekendHistoryCacheKey);
        if (weekendData) {
          console.log(`Using weekend cache for ${symbol} from ${tradingDay}`);
          historyData = weekendData;
        }
      } catch (kvError) {
        console.error('Weekend cache lookup error:', kvError);
      }
    }

    let quoteData;
    
    try {
      quoteData = await kv.get(quoteCacheKey);
      // 只在還沒有歷史數據時才嘗試從快取取得
      if (!historyData) {
        historyData = await kv.get(historyCacheKey);
      }
      console.log(`Cache lookup successful for ${symbol}. Quote cached: ${!!quoteData}, History cached: ${!!historyData}`);
    } catch (kvError) {
      console.error('KV Cache error:', kvError);
      // Continue without cache if KV fails
      quoteData = null;
      if (!historyData) {
        historyData = null;
      }
    }

    // 獲取即時報價 (若快取中沒有) - 優先使用 Finnhub，失敗時使用 yfinance
    if (!quoteData) {
      const finnhubSymbol = symbol.replace(/\.US$/, '');
      
      // 首先嘗試 Finnhub
      try {
        const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${finnhubSymbol}&token=${finnhubApiKey}`;
        const finnhubQuoteUrl = `https://finnhub.io/api/v1/quote?symbol=${finnhubSymbol}&token=${finnhubApiKey}`;
        
        const [profileResponse, finnhubQuoteResponse] = await Promise.all([fetch(profileUrl), fetch(finnhubQuoteUrl)]);
        
        if (profileResponse.ok && finnhubQuoteResponse.ok) {
          const profileJson = await profileResponse.json();
          const quoteJson = await finnhubQuoteResponse.json();

          if (quoteJson.c && quoteJson.c !== 0) {
            console.log(`Successfully used Finnhub for quote data: ${symbol}`);
            quoteData = {
                name: profileJson.name || symbol,
                price: quoteJson.c,
                change: quoteJson.d,
                changePercent: quoteJson.dp,
                high: quoteJson.h,
                low: quoteJson.l,
            };
          } else {
            console.warn(`Finnhub returned invalid quote data for ${symbol}, trying yfinance fallback`);
            throw new Error('Invalid Finnhub data');
          }
        } else {
          console.warn(`Finnhub API error for ${symbol} (${profileResponse.status}/${finnhubQuoteResponse.status}), trying yfinance fallback`);
          throw new Error('Finnhub API error');
        }
      } catch (finnhubError) {
        console.log(`Finnhub failed for ${symbol}, trying yfinance as fallback:`, finnhubError.message);
        
        // 使用 yfinance 作為備用方案獲取即時報價
        try {
          // 使用外部 yfinance API 服務
          const yfinanceData = await getYfinanceData(finnhubSymbol, 'D');
            
          if (yfinanceData.history && yfinanceData.history.length > 0) {
            const latestData = yfinanceData.history[yfinanceData.history.length - 1];
            const previousData = yfinanceData.history[yfinanceData.history.length - 2] || latestData;
            
            const change = latestData.close - previousData.close;
            const changePercent = previousData.close !== 0 ? (change / previousData.close) * 100 : 0;
            
            console.log(`Successfully used yfinance for quote data: ${symbol}`);
            quoteData = {
              name: yfinanceData.name || symbol,
              price: latestData.close,
              change: change,
              changePercent: changePercent,
              high: latestData.high,
              low: latestData.low,
            };
          } else {
            throw new Error('yfinance returned empty data');
          }
        } catch (yfinanceError) {
          console.error(`Both Finnhub and yfinance failed for ${symbol}:`, yfinanceError.message);
          return response.status(404).json({ 
            error: `無法獲取 ${symbol} 的即時報價資料`,
            details: `Finnhub: ${finnhubError.message}, yfinance: ${yfinanceError.message}`
          });
        }
      }
      
      // 🚀 改善快取策略 - 延長快取時間，減少 API 呼叫
      if (quoteData) {
        try {
          // 市場時間內快取30秒，市場關閉時快取10分鐘
          const now = new Date();
          const isMarketOpen = (now.getUTCHours() >= 13 && now.getUTCHours() <= 21); // 美股開市時間 (UTC)
          const cacheTime = isMarketOpen ? 30 : 600; // 30秒 或 10分鐘
          
          await kv.set(quoteCacheKey, quoteData, { ex: cacheTime });
          console.log(`Quote data cached for ${symbol} (${cacheTime}s)`);
        } catch (kvError) {
          console.error('KV Cache write error (quote):', kvError);
        }
      }
    }

    // 從多個數據源獲取歷史資料 (若快取中沒有)
    if (!historyData) {
      const cleanSymbol = symbol.replace(/\.US$/, '');
      let cacheTime;

      // 檢查是否已經有其他請求正在獲取相同的數據
      const requestKey = `${historyCacheKey}_pending`;
      if (pendingRequests.has(requestKey)) {
        console.log(`[${new Date().toISOString()}] Waiting for existing request for ${symbol}`);
        try {
          historyData = await pendingRequests.get(requestKey);
          console.log(`[${new Date().toISOString()}] Got data from pending request for ${symbol}`);
        } catch (error) {
          console.error(`Pending request failed for ${symbol}:`, error);
          historyData = null;
        }
      }

      if (!historyData) {
        console.log(`[${new Date().toISOString()}] Fetching fresh historical data for ${symbol} on trading day ${tradingDay} (requested: ${today})`);
        
        // 創建一個 Promise 來獲取數據，並將其存儲在 pendingRequests 中
        const fetchPromise = fetchHistoricalData(cleanSymbol, timeframe, finnhubApiKey, polygonApiKey);
        pendingRequests.set(requestKey, fetchPromise);
        
        try {
          const result = await fetchPromise;
          historyData = result.data;
          cacheTime = result.cacheTime;
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Data fetch failed for ${cleanSymbol}:`, error);
          return response.status(404).json({ 
            error: `無法獲取 ${cleanSymbol} 的歷史資料`,
            details: error.message
          });
        } finally {
          // 無論成功或失敗都要清理 pending request
          pendingRequests.delete(requestKey);
        }
      }

      // 快取新獲取的歷史數據
      if (historyData && cacheTime) {
        try {
          await kv.set(historyCacheKey, historyData, { ex: cacheTime });
          console.log(`[${new Date().toISOString()}] History data cached for ${symbol} with key: ${historyCacheKey}, expires in ${cacheTime} seconds`);
        } catch (kvError) {
          console.error('KV Cache write error (history):', kvError);
          // Continue without caching if KV fails
        }
      }
    }

    // 確保所有必要的數據都存在
    if (!quoteData || !historyData) {
      console.error(`Missing data for ${symbol}: quoteData=${!!quoteData}, historyData=${!!historyData}`);
      return response.status(404).json({ 
        error: `無法獲取 ${symbol} 的完整資料`, 
        symbol: symbol,
        missingQuote: !quoteData,
        missingHistory: !historyData
      });
    }

    const processedData = {
      symbol: symbol,
      ...quoteData,
      history: historyData,
    };

    response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return response.status(200).json(processedData);

  } catch (error) {
    console.error('handleGetStockData Error:', error);
    console.error('Error stack:', error.stack);
    console.error('Symbol:', symbol || 'undefined');
    console.error('Timeframe:', timeframe || 'undefined');
    return response.status(500).json({ 
      error: '伺服器內部發生錯誤', 
      details: error.message,
      symbol: symbol || 'unknown'
    });
  }
}

// 處理獲取新聞並翻譯的邏輯 (使用 Finnhub)
async function handleGetNews(request, response) {
    try {
        const { symbol } = request.query;
        if (!symbol) {
            return response.status(400).json({ error: '必須提供股票代號' });
        }
        const apiSymbol = symbol.replace(/\.US$/, '');

        const finnhubApiKey = process.env.FINNHUB_API_KEY;
        if (!finnhubApiKey) {
            return response.status(500).json({ error: 'FINNHUB_API_KEY 未設定' });
        }

        const today = new Date();
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(today.getDate() - 7);
        const toDate = today.toISOString().split('T')[0];
        const fromDate = sevenDaysAgo.toISOString().split('T')[0];

        const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${apiSymbol}&from=${fromDate}&to=${toDate}&token=${finnhubApiKey}`;
        const newsResponse = await fetch(newsUrl);

        if (!newsResponse.ok) {
            throw new Error(`從 Finnhub 獲取新聞失敗: ${symbol}`);
        }
        
        let newsData = await newsResponse.json();
        newsData = newsData.slice(0, 5);

        const translatedNews = await Promise.all(newsData.map(async (article) => {
            if (/[a-zA-Z]/.test(article.headline)) {
                const translatedHeadline = await translateText(article.headline);
                return { ...article, headline: translatedHeadline || article.headline };
            }
            return article;
        }));

        response.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
        return response.status(200).json(translatedNews);

    } catch (error) {
        console.error('handleGetNews Error:', error);
        console.error('News error stack:', error.stack);
        return response.status(500).json({ 
          error: '獲取新聞時發生錯誤',
          details: error.message 
        });
    }
}

// 呼叫 Gemini 進行翻譯的輔助函式
async function translateText(textToTranslate) {
    try {
        const geminiApiKey = process.env.GEMINI_API_KEY;
        if (!geminiApiKey) {
            console.error('GEMINI_API_KEY 未設定，無法翻譯');
            return null;
        }
        const prompt = `Translate the following English headline to Traditional Chinese. Provide ONLY the translated text, without any original text, quotation marks, or explanations. Headline: "${textToTranslate}"`;
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!geminiResponse.ok) return null;

        const result = await geminiResponse.json();
        if (result.candidates?.[0]?.content?.parts?.[0]) {
            return result.candidates[0].content.parts[0].text.replace(/"/g, '');
        }
        return null;
    } catch (error) {
        console.error('Translate Error:', error);
        return null;
    }
}


// 處理呼叫 Gemini API 進行 AI 分析的邏輯
async function handleGeminiAnalysis(request, response) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return response.status(500).json({ error: 'GEMINI_API_KEY 未設定' });
    }
    const { stock, indicators } = request.body;
    const prompt = `You are a helpful financial analyst assistant for retail investors in Taiwan. Your tone should be neutral, informative, and easy to understand, avoiding hype or definitive financial advice. Based on the following real-time technical data for the stock, provide a brief analysis in Traditional Chinese, formatted in Markdown. Follow this structure: 1. Start with a one-sentence summary in bold. 2. Then, explain the key indicators in a bulleted list. 3. Conclude with the mandatory disclaimer: "此分析僅供參考，不構成任何投資建議。" Data: - Stock Name: ${stock.name} - Current Price: ${stock.price.toFixed(2)} ${stock.currency} - RSI (14D): ${indicators.rsi.toFixed(2)} - Price vs Bollinger Bands (20D): The price is ${stock.price > indicators.bb.upper ? 'above the upper band' : stock.price < indicators.bb.lower ? 'below the lower band' : 'within the bands'}. - Price vs Moving Averages: The price is ${stock.price > indicators.ma20 ? 'above' : 'below'} the 20-day moving average. - Volume Ratio (vs 5D Avg): ${(stock.history[0].volume / indicators.avgVol5).toFixed(2)}x Please provide the analysis.`;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
    const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
    const geminiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!geminiResponse.ok) {
        throw new Error(`Gemini API 請求失敗: ${geminiResponse.status}`);
    }
    const result = await geminiResponse.json();
    if (result.candidates?.[0]?.content?.parts?.[0]) {
        const text = result.candidates[0].content.parts[0].text;
        return response.status(200).json({ analysis: text });
    } else {
        throw new Error('從 Gemini API 收到的回應格式不正確。');
    }
  } catch (error) {
    console.error('handleGeminiAnalysis Error:', error);
    console.error('Gemini error stack:', error.stack);
    return response.status(500).json({ 
      error: 'Gemini 分析時發生錯誤',
      details: error.message 
    });
  }
}
