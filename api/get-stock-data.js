// Vercel Serverless Function with KV Caching
// 檔案路徑: /api/get-stock-data.js
// 需要在 Vercel 專案中連結 Vercel KV 儲存體

import { kv } from '@vercel/kv';

// 全局變數來追蹤正在進行的請求
const pendingRequests = new Map();

// 追蹤 API key 狀態
const apiKeyStatus = {
  twelveData: {
    primary: { working: true, lastError: null, lastUsed: null },
    backup: { working: true, lastError: null, lastUsed: null }
  }
};

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
    const backupTwelveDataKey = process.env.TWELVE_DATA_API_KEY_BACKUP;
    const twelveDataKeys = [primaryTwelveDataKey, backupTwelveDataKey].filter(key => key);
    
    console.log(`Available Twelve Data keys: ${twelveDataKeys.length} (primary: ${!!primaryTwelveDataKey}, backup: ${!!backupTwelveDataKey})`);
    
    // 使用 Twelve Data API 獲取歷史數據（嘗試多個 keys）
    if (twelveDataKeys.length > 0) {
      for (let i = 0; i < twelveDataKeys.length; i++) {
        const apiKey = twelveDataKeys[i];
        const keyType = i === 0 ? 'primary' : 'backup';
        
        try {
          console.log(`[${new Date().toISOString()}] Trying Twelve Data API with ${keyType} key for ${cleanSymbol}`);
          
          const twelveDataUrl = `https://api.twelvedata.com/time_series?symbol=${cleanSymbol}&interval=1day&outputsize=250&apikey=${apiKey}`;
          const twelveResponse = await fetch(twelveDataUrl);
          
          if (twelveResponse.ok) {
            const twelveJson = await twelveResponse.json();
            
            // 檢查是否有錯誤響應（API 配額用完等）
            if (twelveJson.code && twelveJson.message) {
              console.warn(`Twelve Data ${keyType} key error:`, twelveJson.message);
              
              // 更新 API key 狀態
              apiKeyStatus.twelveData[keyType].working = false;
              apiKeyStatus.twelveData[keyType].lastError = twelveJson.message;
              apiKeyStatus.twelveData[keyType].lastUsed = new Date().toISOString();
              
              if (i === twelveDataKeys.length - 1) {
                console.error('All Twelve Data keys failed, will use Finnhub as fallback');
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
              console.warn(`Twelve Data ${keyType} key returned invalid data format:`, twelveJson);
              continue; // 嘗試下一個 key
            }
          } else {
            console.warn(`Twelve Data ${keyType} key HTTP error:`, twelveResponse.status, twelveResponse.statusText);
            
            // 更新 API key HTTP 錯誤狀態
            apiKeyStatus.twelveData[keyType].working = false;
            apiKeyStatus.twelveData[keyType].lastError = `HTTP ${twelveResponse.status}: ${twelveResponse.statusText}`;
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
      try {
        const finnhubHistoryUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${cleanSymbol}&resolution=D&from=${Math.floor(Date.now()/1000) - (250 * 24 * 60 * 60)}&to=${Math.floor(Date.now()/1000)}&token=${finnhubApiKey}`;
        const finnhubResponse = await fetch(finnhubHistoryUrl);
        
        if (finnhubResponse.ok) {
          const finnhubJson = await finnhubResponse.json();
          
          if (finnhubJson.s === 'ok' && finnhubJson.c?.length > 0) {
            historyData = finnhubJson.c.map((close, i) => ({
              date: new Date(finnhubJson.t[i] * 1000).toISOString().split('T')[0],
              open: finnhubJson.o[i],
              high: finnhubJson.h[i],
              low: finnhubJson.l[i],
              close: close,
              volume: finnhubJson.v[i]
            })).reverse(); // Finnhub返回的數據是倒序的
            
            console.log('Using Finnhub daily data as fallback:', historyData.length, 'points');
          }
        }
      } catch (error) {
        console.error('Finnhub daily fetch error:', error);
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
async function handleApiStatus(request, response) {
  try {
    const statusReport = {
      timestamp: new Date().toISOString(),
      environment: {
        FINNHUB_API_KEY: !!process.env.FINNHUB_API_KEY,
        TWELVE_DATA_API_KEY: !!process.env.TWELVE_DATA_API_KEY,
        TWELVE_DATA_API_KEY_BACKUP: !!process.env.TWELVE_DATA_API_KEY_BACKUP,
        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
        KV_CONFIGURED: !!(process.env.KV_URL && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
      },
      apiStatus: apiKeyStatus,
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
  try {
    const { symbol, timeframe } = request.query;
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
    
    // 如果週末還沒取到歷史數據，初始化為 null
    if (!historyData) {
      historyData = null;
    }
    
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
          console.error(`Failed to fetch historical data for ${cleanSymbol}:`, error);
          // 創建一個包含當前報價的歷史數據點作為備用
          if (quoteData && quoteData.price) {
            historyData = [{
              date: new Date().toISOString().split('T')[0],
              open: quoteData.price,
              high: quoteData.high || quoteData.price,
              low: quoteData.low || quoteData.price,
              close: quoteData.price,
              volume: 0
            }];
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
    console.error('Symbol:', symbol);
    console.error('Timeframe:', timeframe);
    return response.status(500).json({ 
      error: '伺服器內部發生錯誤', 
      details: error.message,
      symbol: symbol 
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
