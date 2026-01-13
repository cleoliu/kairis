// Vercel Serverless Function with KV Caching
// 檔案路徑: /api/get-stock-data.js
// 需要在 Vercel 專案中連結 Vercel KV 儲存體

import { kv } from '@vercel/kv';

// 全局變數來追蹤正在進行的請求
const pendingRequests = new Map();

// 追蹤 API key 狀態
const apiKeyStatus = {
  polygon: { working: true, lastError: null, lastUsed: null }
};

// Polygon.io Rate Limit 控制 (免費版：5 requests/minute)
const polygonRateLimit = {
  requestTimestamps: [],
  maxRequests: 5,
  windowMs: 60000, // 1分鐘
  minInterval: 1000, // 每次請求間隔1秒（從12秒降低）
  isRateLimited: false,
  rateLimitResetTime: 0
};

// 檢查是否可以發起 Polygon.io 請求
function canMakePolygonRequest() {
  const now = Date.now();
  
  if (polygonRateLimit.isRateLimited) {
    if (now > polygonRateLimit.rateLimitResetTime) {
      polygonRateLimit.isRateLimited = false;
      console.log(`[${new Date().toISOString()}] Polygon.io rate limit expired`);
    } else {
      const waitTime = Math.ceil((polygonRateLimit.rateLimitResetTime - now) / 1000);
      console.warn(`[${new Date().toISOString()}] Polygon.io is rate limited, wait ${waitTime}s`);
      return { canMake: false, waitTime };
    }
  }
  
  // 清理超過時間窗口的記錄
  polygonRateLimit.requestTimestamps = polygonRateLimit.requestTimestamps.filter(
    timestamp => now - timestamp < polygonRateLimit.windowMs
  );
  
  // 檢查是否超過請求數限制
  if (polygonRateLimit.requestTimestamps.length >= polygonRateLimit.maxRequests) {
    const oldestRequest = polygonRateLimit.requestTimestamps[0];
    const waitTime = Math.ceil((oldestRequest + polygonRateLimit.windowMs - now) / 1000);
    console.warn(`[${new Date().toISOString()}] Polygon.io rate limit: ${polygonRateLimit.requestTimestamps.length}/${polygonRateLimit.maxRequests} requests, wait ${waitTime}s`);
    return { canMake: false, waitTime };
  }
  
  // 檢查最小間隔
  if (polygonRateLimit.requestTimestamps.length > 0) {
    const lastRequest = polygonRateLimit.requestTimestamps[polygonRateLimit.requestTimestamps.length - 1];
    const timeSinceLastRequest = now - lastRequest;
    if (timeSinceLastRequest < polygonRateLimit.minInterval) {
      const waitTime = Math.ceil((polygonRateLimit.minInterval - timeSinceLastRequest) / 1000);
      console.log(`[${new Date().toISOString()}] Polygon.io min interval not met, wait ${waitTime}s`);
      return { canMake: false, waitTime };
    }
  }
  
  return { canMake: true, waitTime: 0 };
}

// 記錄 Polygon.io 請求
function recordPolygonRequest() {
  polygonRateLimit.requestTimestamps.push(Date.now());
  console.log(`[${new Date().toISOString()}] Polygon.io requests in window: ${polygonRateLimit.requestTimestamps.length}/${polygonRateLimit.maxRequests}`);
}

// Polygon.io 數據獲取函數 - 主要數據源（速度快）
async function getPolygonData(cleanSymbol, timeframe, apiKey) {
  try {
    console.log(`[${new Date().toISOString()}] Using Polygon.io API for ${cleanSymbol}, timeframe=${timeframe}`);
    
    // 檢查 rate limit
    const rateLimitCheck = canMakePolygonRequest();
    if (!rateLimitCheck.canMake) {
      throw new Error(`Rate limited: wait ${rateLimitCheck.waitTime}s`);
    }
    
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
    
    // 記錄請求
    recordPolygonRequest();
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    // 處理 HTTP 429 錯誤
    if (response.status === 429) {
      polygonRateLimit.isRateLimited = true;
      polygonRateLimit.rateLimitResetTime = Date.now() + 60000; // 1分鐘後重試
      throw new Error('HTTP 429: Rate limit exceeded');
    }
    
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

// 處理 Grouped Daily 請求
async function handleGroupedDaily(request, response) {
  try {
    const { symbols } = request.query;
    
    if (!symbols) {
      return response.status(400).json({ error: '必須提供 symbols 參數' });
    }
    
    const polygonApiKey = process.env.POLYGON_API_KEY;
    if (!polygonApiKey) {
      return response.status(500).json({ error: 'POLYGON_API_KEY 未設定' });
    }
    
    const symbolList = symbols.split(',').map(s => s.trim().replace(/\.US$/, ''));
    console.log(`[${new Date().toISOString()}] Grouped daily request for ${symbolList.length} symbols`);
    
    // 獲取當前日期字符串
    const today = new Date().toISOString().split('T')[0];
    const groupedCacheKey = `grouped_daily_${today}`;
    
    // 嘗試從快取獲取
    let stockMap;
    try {
      const cached = await kv.get(groupedCacheKey);
      if (cached) {
        console.log(`[${new Date().toISOString()}] Using cached grouped daily data`);
        stockMap = new Map(Object.entries(cached));
      }
    } catch (kvError) {
      console.error('KV Cache read error:', kvError);
    }
    
    // 如果快取中沒有，從 API 獲取
    if (!stockMap) {
      stockMap = await getPolygonGroupedDaily(polygonApiKey);
      
      if (!stockMap) {
        return response.status(500).json({ error: '無法獲取 grouped daily 數據' });
      }
      
      // 快取到收盤時間
      try {
        const now = new Date();
        const marketCloseUTC = new Date(now);
        marketCloseUTC.setUTCHours(21, 0, 0, 0);
        
        const cacheTime = now < marketCloseUTC 
          ? Math.floor((marketCloseUTC - now) / 1000)
          : 86400 * 7;
        
        // 轉換 Map 為 Object 以便快取
        const cacheData = Object.fromEntries(stockMap);
        await kv.set(groupedCacheKey, cacheData, { ex: cacheTime });
        console.log(`[${new Date().toISOString()}] Grouped daily data cached for ${cacheTime}s`);
      } catch (kvError) {
        console.error('KV Cache write error:', kvError);
      }
    }
    
    // 提取用戶請求的股票數據
    const result = {};
    symbolList.forEach(symbol => {
      const data = stockMap.get(symbol);
      if (data) {
        result[symbol] = data;
      }
    });
    
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return response.status(200).json({
      success: true,
      count: Object.keys(result).length,
      requested: symbolList.length,
      data: result
    });
    
  } catch (error) {
    console.error('handleGroupedDaily Error:', error);
    return response.status(500).json({ 
      error: '獲取 grouped daily 數據時發生錯誤',
      details: error.message 
    });
  }
}

// 處理緩存預熱請求 - 供 n8n 每日定時調用
async function handleWarmupCache(request, response) {
  try {
    // 支持 GET (query params) 和 POST (JSON body) 兩種方式
    let symbols, secret;
    
    if (request.method === 'POST') {
      // POST 方法：從 body 讀取
      symbols = request.body?.symbols;
      secret = request.body?.secret;
    } else {
      // GET 方法：從 query params 讀取
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
    
    if (!polygonApiKey || !finnhubApiKey) {
      return response.status(500).json({ error: 'API keys 未設定' });
    }
    
    const symbolList = symbols.split(',').map(s => s.trim());
    console.log(`[${new Date().toISOString()}] 🔥 Warmup cache request for ${symbolList.length} symbols`);
    
    const results = {
      success: [],
      failed: [],
      total: symbolList.length
    };
    
    // 批次處理，每批3個股票
    const BATCH_SIZE = 3;
    for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
      const batch = symbolList.slice(i, i + BATCH_SIZE);
      
      await Promise.allSettled(
        batch.map(async (symbol) => {
          const maxRetries = 2;
          let lastError = null;
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              const cleanSymbol = symbol.replace(/\.US$/, '');
              const today = new Date().toISOString().split('T')[0];
              
              console.log(`[${new Date().toISOString()}] 📊 Warmup ${symbol} (attempt ${attempt}/${maxRetries})...`);
              
              // 在重試前等待
              if (attempt > 1) {
                const waitTime = attempt * 5000; // 第2次等5秒，第3次等10秒
                console.log(`[${new Date().toISOString()}] Waiting ${waitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
              }
              
              // 獲取歷史數據
              console.log(`[${new Date().toISOString()}] Calling fetchHistoricalData for ${cleanSymbol}...`);
              const historyResult = await fetchHistoricalData(cleanSymbol, null, finnhubApiKey, polygonApiKey);
              console.log(`[${new Date().toISOString()}] fetchHistoricalData result:`, { 
                hasData: !!historyResult?.data, 
                isArray: Array.isArray(historyResult?.data),
                length: historyResult?.data?.length 
              });
              
              if (historyResult?.data && Array.isArray(historyResult.data) && historyResult.data.length > 0) {
                // 緩存歷史數據
                const historyCacheKey = `global_history_${symbol}_${today}`;
                const cacheTime = 86400 * 7; // 7天
                
                await kv.set(historyCacheKey, historyResult.data, { ex: cacheTime });
                
                console.log(`[${new Date().toISOString()}] ✅ Cached ${symbol}: ${historyResult.data.length} data points`);
                results.success.push(symbol);
                return; // 成功，退出重試循環
              } else {
                const errorMsg = historyResult?.data ? 'Empty data array' : 'No data returned from fetchHistoricalData';
                throw new Error(errorMsg);
              }
            } catch (error) {
              lastError = error;
              const errorDetail = error.message || error.toString();
              console.error(`[${new Date().toISOString()}] ❌ Attempt ${attempt}/${maxRetries} failed for ${symbol}:`, errorDetail);
              
              if (attempt === maxRetries) {
                // 最後一次重試也失敗了
                console.error(`[${new Date().toISOString()}] All retries exhausted for ${symbol}`);
                results.failed.push({ symbol, error: errorDetail });
              }
            }
          }
        })
      );
      
      // 避免 API rate limit，批次之間等待更長時間
      if (i + BATCH_SIZE < symbolList.length) {
        console.log(`[${new Date().toISOString()}] Waiting 20s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 20000)); // 等待20秒
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


export default async function handler(request, response) {
  // 支持從 query 或 body 讀取 action
  const action = request.query?.action || request.body?.action;

  if (request.method === 'GET') {
    if (action === 'get_news') {
      return handleGetNews(request, response);
    } else if (action === 'api_status') {
      return handleApiStatus(request, response);
    } else if (action === 'grouped_daily') {
      return handleGroupedDaily(request, response);
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

// 獲取歷史數據的獨立函數 - 只使用 Polygon.io
async function fetchHistoricalData(cleanSymbol, timeframe, finnhubApiKey, polygonApiKey) {
  console.log(`[${new Date().toISOString()}] fetchHistoricalData called for ${cleanSymbol}, timeframe=${timeframe}`);
  
  const cacheTime = timeframe === '5M' ? 3600 : 86400 * 7;
  
  if (!polygonApiKey) {
    const error = 'POLYGON_API_KEY not configured';
    console.error(`[${new Date().toISOString()}] ❌ ${error}`);
    throw new Error(error);
  }
  
  try {
    console.log(`[${new Date().toISOString()}] Calling getPolygonData for ${cleanSymbol}...`);
    const polygonResult = await getPolygonData(cleanSymbol, timeframe, polygonApiKey);
    console.log(`[${new Date().toISOString()}] getPolygonData result:`, { 
      hasResult: !!polygonResult,
      hasHistory: !!polygonResult?.history,
      historyLength: polygonResult?.history?.length 
    });
    
    if (polygonResult?.history?.length > 0) {
      console.log(`[${new Date().toISOString()}] ✅ Polygon.io success: ${polygonResult.history.length} data points for ${cleanSymbol}`);
      return { data: polygonResult.history, cacheTime };
    }
    
    const errorMsg = `Polygon.io returned no data for ${cleanSymbol}`;
    console.error(`[${new Date().toISOString()}] ❌ ${errorMsg}`);
    throw new Error(errorMsg);
    
  } catch (error) {
    const errorMsg = `Polygon.io fetch failed for ${cleanSymbol}: ${error.message}`;
    console.error(`[${new Date().toISOString()}] ❌ ${errorMsg}`);
    throw new Error(errorMsg);
  }
}

// 處理 API 狀態查詢
async function handleApiStatus(_, response) {
  try {
    const statusReport = {
      timestamp: new Date().toISOString(),
      environment: {
        POLYGON_API_KEY: !!process.env.POLYGON_API_KEY,
        FINNHUB_API_KEY: !!process.env.FINNHUB_API_KEY,
        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
        KV_CONFIGURED: !!(process.env.KV_URL && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
      },
      apiStatus: apiKeyStatus,
      polygonRateLimit: {
        requestsInWindow: polygonRateLimit.requestTimestamps.length,
        maxRequests: polygonRateLimit.maxRequests,
        isRateLimited: polygonRateLimit.isRateLimited,
        canMakeRequest: canMakePolygonRequest().canMake
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

    const finnhubApiKey = process.env.FINNHUB_API_KEY;
    const polygonApiKey = process.env.POLYGON_API_KEY;

    if (!finnhubApiKey) {
      return response.status(500).json({ error: 'FINNHUB_API_KEY 未設定' });
    }
    
    if (!polygonApiKey) {
      return response.status(500).json({ error: 'POLYGON_API_KEY 未設定' });
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

    // 獲取即時報價 (若快取中沒有)
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
            throw new Error('Invalid Finnhub quote data - price is 0 or null');
          }
        } else {
          throw new Error(`Finnhub API error: ${profileResponse.status}/${finnhubQuoteResponse.status}`);
        }
      } catch (finnhubError) {
        console.error(`Finnhub failed for ${symbol}:`, finnhubError.message);
        return response.status(404).json({ 
          error: `無法獲取 ${symbol} 的即時報價資料`,
          details: finnhubError.message
        });
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
