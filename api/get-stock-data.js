// Vercel Serverless Function with KV Caching
// 檔案路徑: /api/get-stock-data.js
// 需要在 Vercel 專案中連結 Vercel KV 儲存體

import { kv } from '@vercel/kv';

export default async function handler(request, response) {
  const { action } = request.query;

  if (request.method === 'GET') {
    if (action === 'get_news') {
      return handleGetNews(request, response);
    }
    return handleGetStockData(request, response);
  } else if (request.method === 'POST') {
    return handleGeminiAnalysis(request, response);
  } else {
    response.setHeader('Allow', ['GET', 'POST']);
    return response.status(405).end(`Method ${request.method} Not Allowed`);
  }
}

// 處理從 Finnhub (即時) 和 FMP (歷史) 獲取股價資料的邏輯
async function handleGetStockData(request, response) {
  try {
    const { symbol, timeframe } = request.query;
    if (!symbol) {
      return response.status(400).json({ error: '必須提供股票代號' });
    }

    const finnhubApiKey = process.env.FINNHUB_API_KEY;
    const fmpApiKey = process.env.FMP_API_KEY;

    if (!finnhubApiKey || !fmpApiKey) {
      return response.status(500).json({ error: 'FINNHUB_API_KEY 或 FMP_API_KEY 未設定' });
    }

    const quoteCacheKey = `quote_finnhub_${symbol}`;
    const historyCacheKey = timeframe === '5M' ? `intraday_fmp_${symbol}` : `history_fmp_${symbol}`;

    let quoteData = await kv.get(quoteCacheKey);
    let historyData = await kv.get(historyCacheKey);

    // 從 Finnhub 獲取即時報價 (若快取中沒有)
    if (!quoteData) {
      const finnhubSymbol = symbol.replace(/\.US$|\.TW$/, '');
      const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${finnhubSymbol}&token=${finnhubApiKey}`;
      const finnhubQuoteUrl = `https://finnhub.io/api/v1/quote?symbol=${finnhubSymbol}&token=${finnhubApiKey}`;
      
      const [profileResponse, finnhubQuoteResponse] = await Promise.all([fetch(profileUrl), fetch(finnhubQuoteUrl)]);
      if (!profileResponse.ok || !finnhubQuoteResponse.ok) {
        return response.status(404).json({ error: `找不到 Finnhub 即時報價資料: ${symbol}` });
      }
      const profileJson = await profileResponse.json();
      const quoteJson = await finnhubQuoteResponse.json();

      if (quoteJson.c === 0 && !profileJson.name) {
         return response.status(404).json({ error: `找不到 Finnhub 資料: ${symbol}` });
      }
      quoteData = {
          name: profileJson.name || symbol,
          price: quoteJson.c,
          change: quoteJson.d,
          changePercent: quoteJson.dp,
          high: quoteJson.h,
          low: quoteJson.l,
      };
      await kv.set(quoteCacheKey, quoteData, { ex: 60 }); // 快取 1 分鐘
    }

    // 從 FMP 獲取歷史資料 (若快取中沒有)
    if (!historyData) {
      const fmpSymbol = symbol.replace(/\.US$|\.TW$/, '');
      let historyUrl, cacheTime;

      if (timeframe === '5M') {
        // 5分線數據 - 嘗試不同的API端點
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        
        // 首先嘗試當天數據，如果失敗則嘗試昨天數據
        historyUrl = `https://financialmodelingprep.com/api/v3/historical-chart/5min/${fmpSymbol}?from=${yesterdayStr}&to=${today}&apikey=${fmpApiKey}`;
        cacheTime = 300; // 快取 5 分鐘
        
        console.log(`Fetching 5min data for ${fmpSymbol} from ${yesterdayStr} to ${today}`);
      } else {
        // 日線/週線數據
        historyUrl = `https://financialmodelingprep.com/api/v3/historical-price-full/${fmpSymbol}?apikey=${fmpApiKey}`;
        cacheTime = 86400; // 快取 24 小時
      }

      const historyResponse = await fetch(historyUrl);

      if (!historyResponse.ok) {
        return response.status(500).json({ error: `從 FMP 獲取${timeframe === '5M' ? '5分線' : '歷史'}資料失敗` });
      }
      const historyJson = await historyResponse.json();

      if (timeframe === '5M') {
        // 5分線數據處理
        console.log('5min API response:', { length: historyJson?.length, sample: historyJson?.slice(0, 2) });
        
        if (!historyJson || historyJson.length === 0) {
          // 如果5分線數據不可用，使用Finnhub的分時數據作為備用
          console.log(`No FMP 5min data available for ${fmpSymbol}, trying Finnhub intraday...`);
          
          // 嘗試使用Finnhub的分時數據
          const finnhubSymbol = symbol.replace(/\.US$|\.TW$/, '');
          const intradayUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${finnhubSymbol}&resolution=5&from=${Math.floor(Date.now()/1000) - 86400}&to=${Math.floor(Date.now()/1000)}&token=${finnhubApiKey}`;
          
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
                return response.status(404).json({ error: `找不到 ${symbol} 的5分線資料 (FMP和Finnhub都無數據)` });
              }
            } else {
              return response.status(404).json({ error: `找不到 FMP 5分線資料: ${symbol}` });
            }
          } catch (error) {
            console.error('Finnhub intraday fetch error:', error);
            return response.status(404).json({ error: `找不到 FMP 5分線資料: ${symbol}` });
          }
        } else {
          historyData = historyJson.slice(0, 78).reverse().map(d => ({ // 當天最多78個5分鐘K線 (6.5小時)
            date: d.date,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.volume
          }));
        }
      } else {
        // 日線/週線數據處理
        if (!historyJson.historical || historyJson.historical.length === 0) {
          return response.status(404).json({ error: `找不到 FMP 歷史資料: ${symbol}` });
        }
        
        historyData = historyJson.historical.slice(0, 250).map(d => ({
          date: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume
        }));
      }
      
      await kv.set(historyCacheKey, historyData, { ex: cacheTime });
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
    return response.status(500).json({ error: '伺服器內部發生錯誤' });
  }
}

// 處理獲取新聞並翻譯的邏輯 (使用 Finnhub)
async function handleGetNews(request, response) {
    try {
        const { symbol } = request.query;
        if (!symbol) {
            return response.status(400).json({ error: '必須提供股票代號' });
        }
        const apiSymbol = symbol.replace(/\.US$|\.TW$/, '');

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
        return response.status(500).json({ error: '獲取新聞時發生錯誤' });
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
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${geminiApiKey}`;
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
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${geminiApiKey}`;
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
    return response.status(500).json({ error: 'Gemini 分析時發生錯誤' });
  }
}
