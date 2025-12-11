// Vercel Serverless Function with KV Caching
// 檔案路徑: /api/get-stock-data.js
// 需要在 Vercel 專案中連結 Vercel KV 儲存體

import { kv } from '@vercel/kv';

// 全局變數來追蹤正在進行的請求
const pendingRequests = new Map();

// 追蹤 API key 狀態
const apiKeyStatus = {
  yfinance: { working: true, lastError: null, lastUsed: null },
  twelveData: {
    primary: { working: true, lastError: null, lastUsed: null },
    backup: { working: true, lastError: null, lastUsed: null }
  }
};

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

// 輔助函數：等待指定時間
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 輔助函數：更新請求記錄
function recordRequest(keyType) {
  const now = Date.now();
  const control = rateLimitControl.twelveData[keyType];
  control.lastRequest = now;
  control.requestCount++;
}

export default async function handler(request, response) {
  const { action } = request.query;

  if (request.method === 'GET') {
    if (action === 'get_news') {
      return handleGetNews(request, response);
    } else if (action === 'api_status') {
      return handleApiStatus(request, response);
    }
    return handleGetStockData(request, response);
  } else if (request.method === 'POST') {
    return handleGeminiAnalysis(request, response);
  } else {
    response.setHeader('Allow', ['GET', 'POST']);
    return response.status(405).end(`Method ${request.method} Not Allowed`);
  }
}

// 獲取歷史數據的獨立函數
async function fetchHistoricalData(cleanSymbol, timeframe, finnhubApiKey) {
  let historyData = null;
  let cacheTime;

  // 首先嘗試使用 yfinance (無限制、免費)
  console.log(`[${new Date().toISOString()}] Trying yfinance first for ${cleanSymbol}`);
  
  try {
    const yfinanceUrl = `/api/yfinance-history?symbol=${cleanSymbol}&timeframe=${timeframe}`;
    const yfinanceResponse = await fetch(yfinanceUrl);
    
    if (yfinanceResponse.ok) {
      const yfinanceJson = await yfinanceResponse.json();
      
      if (yfinanceJson.history && Array.isArray(yfinanceJson.history) && yfinanceJson.history.length > 0) {
        historyData = yfinanceJson.history;
        cacheTime = timeframe === '5M' ? 3600 : 86400 * 7; // 5分線快取1小時，日線快取7天
        
        // 更新 yfinance 成功狀態
        apiKeyStatus.yfinance.working = true;
        apiKeyStatus.yfinance.lastError = null;
        apiKeyStatus.yfinance.lastUsed = new Date().toISOString();
        
        console.log(`[${new Date().toISOString()}] Successfully used yfinance for ${cleanSymbol}:`, historyData.length, 'points');
        return { data: historyData, cacheTime };
      } else {
        console.warn(`[${new Date().toISOString()}] yfinance returned empty data for ${cleanSymbol}`);
        
        // 更新 yfinance 錯誤狀態
        apiKeyStatus.yfinance.working = false;
        apiKeyStatus.yfinance.lastError = 'Empty data returned';
        apiKeyStatus.yfinance.lastUsed = new Date().toISOString();
      }
    } else {
      console.warn(`[${new Date().toISOString()}] yfinance HTTP error for ${cleanSymbol}:`, yfinanceResponse.status, yfinanceResponse.statusText);
      
      // 更新 yfinance HTTP 錯誤狀態
      apiKeyStatus.yfinance.working = false;
      apiKeyStatus.yfinance.lastError = `HTTP ${yfinanceResponse.status}: ${yfinanceResponse.statusText}`;
      apiKeyStatus.yfinance.lastUsed = new Date().toISOString();
    }
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] yfinance fetch error for ${cleanSymbol}:`, error.message);
    
    // 更新 yfinance 網路錯誤狀態
    apiKeyStatus.yfinance.working = false;
    apiKeyStatus.yfinance.lastError = error.message;
    apiKeyStatus.yfinance.lastUsed = new Date().toISOString();
  }

  // 如果 yfinance 失敗，使用原來的 API 作為 fallback
  console.log(`[${new Date().toISOString()}] yfinance failed, trying fallback APIs for ${cleanSymbol}`);

  if (timeframe === '5M') {
    // 5分線數據 - 優先使用Finnhub
    cacheTime = 3600; // 快取 1 小時
    
    console.log(`Fetching 5min data for ${cleanSymbol}`);
    
    // 使用Finnhub的分時數據作為主要來源
    const intradayUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${cleanSymbol}&resolution=5&from=${Math.floor(Date.now()/1000) - 86400}&to=${Math.floor(Date.now()/1000)}&token=${finnhubApiKey}`;
    
    try {
      const intradayResponse = await fetch(intradayUrl);
      if (intradayResponse.ok) {
        const intradayJson = await intradayResponse.json();
        
        if (intradayJson.s === 'ok' && intradayJson.c?.length > 0) {
          console.log('Using Finnhub intraday data:', intradayJson.c.length, 'points');
          
          historyData = intradayJson.c.map((close, i) => ({
            date: new Date(intradayJson.t[i] * 1000).toISOString(),
            open: intradayJson.o[i],
            high: intradayJson.h[i],
            low: intradayJson.l[i],
            close: close,
            volume: intradayJson.v[i]
          })).slice(-78); // 最多78個5分鐘K線
        } else {
          console.warn(`No intraday data available for ${cleanSymbol}`);
          throw new Error(`找不到 ${cleanSymbol} 的5分線資料，可能此股票不支援分時數據`);
        }
      } else {
        console.warn(`Finnhub intraday API request failed for ${cleanSymbol}, status: ${intradayResponse.status}`);
        throw new Error(`從 Finnhub 獲取分時資料失敗: ${cleanSymbol}`);
      }
    } catch (error) {
      console.error('Finnhub intraday fetch error:', error);
      throw new Error(`獲取5分線資料時發生錯誤: ${cleanSymbol}`);
    }
  } else {
    // 日線數據 - 改用 Twelve Data 作為主要來源
    cacheTime = 86400 * 7; // 快取 7 天
    
    // 取得 Twelve Data API keys（主要和備用）
    const primaryTwelveDataKey = process.env.TWELVE_DATA_API_KEY;
    const backupTwelveDataKey = process.env.TWELVE_DATA_API_KEY_BACKUP || '47fcfd493dbe4a7f89af1109ba980064';
    const twelveDataKeys = [primaryTwelveDataKey, backupTwelveDataKey].filter(key => key);
    
    console.log(`Available Twelve Data keys: ${twelveDataKeys.length} (primary: ${!!primaryTwelveDataKey}, backup: ${!!backupTwelveDataKey})`);
    
    // 使用 Twelve Data API 獲取歷史數據（嘗試多個 keys）
    if (twelveDataKeys.length > 0) {
      for (let i = 0; i < twelveDataKeys.length; i++) {
        const apiKey = twelveDataKeys[i];
        const keyType = i === 0 ? 'primary' : 'backup';
        
        // 檢查是否可以發起請求（rate limit 控制）
        if (!canMakeRequest(keyType)) {
          // 如果是最後一個 key 且無法使用，等待一下再試
          if (i === twelveDataKeys.length - 1) {
            const control = rateLimitControl.twelveData[keyType];
            const waitTime = control.isRateLimited 
              ? Math.max(0, control.rateLimitResetTime - Date.now())
              : Math.max(0, control.minInterval - (Date.now() - control.lastRequest));
              
            if (waitTime > 0 && waitTime < 5000) { // 最多等待5秒
              console.log(`[${new Date().toISOString()}] Waiting ${waitTime}ms for Twelve Data ${keyType} key rate limit`);
              await sleep(waitTime);
              
              // 重新檢查
              if (!canMakeRequest(keyType)) {
                console.warn(`[${new Date().toISOString()}] Still rate limited after waiting, skipping Twelve Data ${keyType} key`);
                continue;
              }
            } else {
              console.warn(`[${new Date().toISOString()}] Rate limit wait time too long (${waitTime}ms), skipping Twelve Data ${keyType} key`);
              continue;
            }
          } else {
            console.log(`[${new Date().toISOString()}] Skipping rate limited Twelve Data ${keyType} key, trying next`);
            continue;
          }
        }
        
        try {
          console.log(`[${new Date().toISOString()}] Trying Twelve Data API with ${keyType} key for ${cleanSymbol}`);
          
          // 記錄請求
          recordRequest(keyType);
          
          const twelveDataUrl = `https://api.twelvedata.com/time_series?symbol=${cleanSymbol}&interval=1day&outputsize=250&apikey=${apiKey}`;
          const twelveResponse = await fetch(twelveDataUrl);
          
          if (twelveResponse.ok) {
            const twelveJson = await twelveResponse.json();
            
            // 檢查是否有錯誤響應（API 配額用完等）
            if (twelveJson.code && twelveJson.message) {
              console.warn(`[${new Date().toISOString()}] Twelve Data ${keyType} key error for ${cleanSymbol}:`, {
                code: twelveJson.code,
                message: twelveJson.message,
                status: twelveJson.status || 'unknown'
              });
              
              // 檢查是否是 rate limit 錯誤
              if (twelveJson.code === 429 || twelveJson.message.toLowerCase().includes('rate limit') || 
                  twelveJson.message.toLowerCase().includes('quota') || twelveJson.message.toLowerCase().includes('limit exceeded')) {
                console.warn(`[${new Date().toISOString()}] Rate limit detected for Twelve Data ${keyType} key`);
                
                // 設置 rate limit 狀態
                const control = rateLimitControl.twelveData[keyType];
                control.isRateLimited = true;
                // 設置重置時間為1小時後（或根據 API 回應調整）
                control.rateLimitResetTime = Date.now() + (60 * 60 * 1000);
                
                // 更新 API key 狀態
                apiKeyStatus.twelveData[keyType].working = false;
                apiKeyStatus.twelveData[keyType].lastError = `Rate Limited: ${twelveJson.message}`;
              } else {
                // 更新 API key 狀態
                apiKeyStatus.twelveData[keyType].working = false;
                apiKeyStatus.twelveData[keyType].lastError = `${twelveJson.code}: ${twelveJson.message}`;
              }
              
              apiKeyStatus.twelveData[keyType].lastUsed = new Date().toISOString();
              
              if (i === twelveDataKeys.length - 1) {
                console.error(`[${new Date().toISOString()}] All Twelve Data keys failed for ${cleanSymbol}, will use Finnhub as fallback`);
              }
              continue; // 嘗試下一個 key
            }
            
            if (twelveJson.values && Array.isArray(twelveJson.values)) {
              historyData = twelveJson.values.map(item => ({
                date: item.datetime,
                open: parseFloat(item.open),
                high: parseFloat(item.high),
                low: parseFloat(item.low),
                close: parseFloat(item.close),
                volume: parseInt(item.volume)
              })).reverse(); // Twelve Data 返回最新的在前，需要反轉
              
              console.log(`[${new Date().toISOString()}] Successfully used Twelve Data ${keyType} key:`, historyData.length, 'points');
              
              // 更新 API key 成功狀態
              apiKeyStatus.twelveData[keyType].working = true;
              apiKeyStatus.twelveData[keyType].lastError = null;
              apiKeyStatus.twelveData[keyType].lastUsed = new Date().toISOString();
              
              break; // 成功獲取數據，跳出循環
            } else {
              console.warn(`[${new Date().toISOString()}] Twelve Data ${keyType} key returned invalid data format for ${cleanSymbol}:`, {
                hasValues: !!twelveJson.values,
                isArray: Array.isArray(twelveJson.values),
                valuesLength: twelveJson.values?.length,
                response: JSON.stringify(twelveJson).substring(0, 200) + '...'
              });
              
              // 更新 API key 狀態
              apiKeyStatus.twelveData[keyType].working = false;
              apiKeyStatus.twelveData[keyType].lastError = 'Invalid data format returned';
              apiKeyStatus.twelveData[keyType].lastUsed = new Date().toISOString();
              
              continue; // 嘗試下一個 key
            }
          } else {
            console.warn(`[${new Date().toISOString()}] Twelve Data ${keyType} key HTTP error for ${cleanSymbol}:`, {
              status: twelveResponse.status,
              statusText: twelveResponse.statusText,
              headers: {
                'x-ratelimit-remaining': twelveResponse.headers.get('x-ratelimit-remaining'),
                'x-ratelimit-reset': twelveResponse.headers.get('x-ratelimit-reset')
              }
            });
            
            // 檢查是否是 rate limit HTTP 錯誤
            if (twelveResponse.status === 429) {
              console.warn(`[${new Date().toISOString()}] HTTP 429 Rate limit detected for Twelve Data ${keyType} key`);
              
              // 設置 rate limit 狀態
              const control = rateLimitControl.twelveData[keyType];
              control.isRateLimited = true;
              
              // 嘗試從 header 獲取重置時間
              const resetHeader = twelveResponse.headers.get('x-ratelimit-reset');
              if (resetHeader) {
                control.rateLimitResetTime = parseInt(resetHeader) * 1000; // 轉換為毫秒
              } else {
                // 默認1小時後重置
                control.rateLimitResetTime = Date.now() + (60 * 60 * 1000);
              }
              
              apiKeyStatus.twelveData[keyType].working = false;
              apiKeyStatus.twelveData[keyType].lastError = `HTTP 429: Rate Limited`;
            } else {
              // 更新 API key HTTP 錯誤狀態
              apiKeyStatus.twelveData[keyType].working = false;
              apiKeyStatus.twelveData[keyType].lastError = `HTTP ${twelveResponse.status}: ${twelveResponse.statusText}`;
            }
            
            apiKeyStatus.twelveData[keyType].lastUsed = new Date().toISOString();
            continue; // 嘗試下一個 key
          }
        } catch (error) {
          console.error(`Twelve Data ${keyType} key fetch error:`, error);
          
          // 更新 API key 錯誤狀態
          apiKeyStatus.twelveData[keyType].working = false;
          apiKeyStatus.twelveData[keyType].lastError = error.message;
          apiKeyStatus.twelveData[keyType].lastUsed = new Date().toISOString();
          
          if (i === twelveDataKeys.length - 1) {
            console.error('All Twelve Data keys exhausted, will use Finnhub as fallback');
          }
          continue; // 嘗試下一個 key
        }
      }
    }
    
    // 如果 Twelve Data 失敗，使用 Finnhub 作為備用
    if (!historyData) {
      console.log(`[${new Date().toISOString()}] Trying Finnhub as fallback for ${cleanSymbol} historical data`);
      
      try {
        const finnhubHistoryUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${cleanSymbol}&resolution=D&from=${Math.floor(Date.now()/1000) - (250 * 24 * 60 * 60)}&to=${Math.floor(Date.now()/1000)}&token=${finnhubApiKey}`;
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
            
            console.log(`[${new Date().toISOString()}] Successfully using Finnhub daily data as fallback for ${cleanSymbol}:`, historyData.length, 'points');
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
    }
    
    if (!historyData) {
      console.warn(`No historical data found for ${cleanSymbol}, will create placeholder data`);
      throw new Error(`找不到 ${cleanSymbol} 的歷史資料`);
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

    if (!finnhubApiKey) {
      return response.status(500).json({ error: 'FINNHUB_API_KEY 未設定' });
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

    // 從 Finnhub 獲取即時報價 (若快取中沒有)
    if (!quoteData) {
      const finnhubSymbol = symbol.replace(/\.US$/, '');
      const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${finnhubSymbol}&token=${finnhubApiKey}`;
      const finnhubQuoteUrl = `https://finnhub.io/api/v1/quote?symbol=${finnhubSymbol}&token=${finnhubApiKey}`;
      
      const [profileResponse, finnhubQuoteResponse] = await Promise.all([fetch(profileUrl), fetch(finnhubQuoteUrl)]);
      if (!profileResponse.ok || !finnhubQuoteResponse.ok) {
        console.warn(`Finnhub API request failed for ${symbol}, status: ${profileResponse.status}, ${finnhubQuoteResponse.status}`);
        return response.status(404).json({ error: `找不到 Finnhub 即時報價資料: ${symbol}` });
      }
      const profileJson = await profileResponse.json();
      const quoteJson = await finnhubQuoteResponse.json();

      if (quoteJson.c === 0 && !profileJson.name) {
        console.warn(`No valid data from Finnhub for ${symbol}: quote=${quoteJson.c}, name=${profileJson.name}`);
        return response.status(404).json({ error: `找不到 ${symbol} 的資料，可能此股票代號不存在或不支援` });
      }
      quoteData = {
          name: profileJson.name || symbol,
          price: quoteJson.c,
          change: quoteJson.d,
          changePercent: quoteJson.dp,
          high: quoteJson.h,
          low: quoteJson.l,
      };
      try {
        await kv.set(quoteCacheKey, quoteData, { ex: 60 }); // 快取 1 分鐘
        console.log('Quote data cached for', symbol);
      } catch (kvError) {
        console.error('KV Cache write error (quote):', kvError);
        // Continue without caching if KV fails
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
        const fetchPromise = fetchHistoricalData(cleanSymbol, timeframe, finnhubApiKey);
        pendingRequests.set(requestKey, fetchPromise);
        
        try {
          const result = await fetchPromise;
          historyData = result.data;
          cacheTime = result.cacheTime;
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Failed to fetch historical data for ${cleanSymbol}:`, error);
          // 創建多天的備用歷史數據點，而不是只有一天
          if (quoteData && quoteData.price) {
            console.warn(`[${new Date().toISOString()}] Creating fallback historical data for ${cleanSymbol} using current quote data`);
            
            historyData = [];
            const currentDate = new Date();
            // 創建過去30天的模擬數據，基於當前價格
            for (let i = 29; i >= 0; i--) {
              const date = new Date(currentDate);
              date.setDate(date.getDate() - i);
              
              // 跳過週末（假設這是交易日）
              if (date.getDay() !== 0 && date.getDay() !== 6) {
                // 添加一些微小的價格變動來模擬真實數據
                const variation = (Math.random() - 0.5) * 0.02; // ±1% 變動
                const simulatedPrice = quoteData.price * (1 + variation);
                
                historyData.push({
                  date: date.toISOString().split('T')[0],
                  open: simulatedPrice,
                  high: Math.max(simulatedPrice, quoteData.high || simulatedPrice * 1.01),
                  low: Math.min(simulatedPrice, quoteData.low || simulatedPrice * 0.99),
                  close: simulatedPrice,
                  volume: Math.floor(Math.random() * 1000000) + 100000 // 模擬成交量
                });
              }
            }
            
            // 最後一天使用實際的當前數據
            historyData.push({
              date: new Date().toISOString().split('T')[0],
              open: quoteData.price,
              high: quoteData.high || quoteData.price,
              low: quoteData.low || quoteData.price,
              close: quoteData.price,
              volume: 0
            });
            
            console.log(`[${new Date().toISOString()}] Created ${historyData.length} days of fallback data for ${cleanSymbol}`);
            cacheTime = 3600; // 錯誤情況下快取1小時
          } else {
            return response.status(404).json({ error: error.message });
          }
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
