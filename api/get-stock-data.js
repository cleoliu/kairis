// Vercel Serverless Function
// 檔案路徑: /api/get-stock-data.js

// 這個函式現在會處理兩種請求：
// 1. GET 請求: 混合呼叫 Finnhub (即時報價) 和 Alpha Vantage (歷史資料)。
// 2. POST 請求: 安全地呼叫 Gemini API 進行 AI 分析。

export default async function handler(request, response) {
  if (request.method === 'GET') {
    return handleGetStockData(request, response);
  } else if (request.method === 'POST') {
    return handleGeminiAnalysis(request, response);
  } else {
    response.setHeader('Allow', ['GET', 'POST']);
    return response.status(405).end(`Method ${request.method} Not Allowed`);
  }
}

// 處理獲取股價資料的邏輯
async function handleGetStockData(request, response) {
  try {
    const { symbol } = request.query;
    if (!symbol) {
      return response.status(400).json({ error: '必須提供股票代號' });
    }

    // 準備給不同 API 使用的代號
    const finnhubSymbol = symbol.replace(/\.US$|\.TW$/, '');
    const alphaVantageSymbol = symbol.endsWith('.US') ? symbol.replace('.US', '') : symbol;

    // 從環境變數中讀取兩個 API 的金鑰
    const finnhubApiKey = process.env.FINNHUB_API_KEY;
    const alphaVantageApiKey = process.env.ALPHA_VANTAGE_API_KEY;

    if (!finnhubApiKey || !alphaVantageApiKey) {
      return response.status(500).json({ error: 'FINNHUB_API_KEY 或 ALPHA_VANTAGE_API_KEY 未設定' });
    }

    // 準備並行發送請求到不同的 API
    const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${finnhubSymbol}&token=${finnhubApiKey}`;
    const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${finnhubSymbol}&token=${finnhubApiKey}`;
    const historyUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${alphaVantageSymbol}&apikey=${alphaVantageApiKey}`;

    const [profileResponse, quoteResponse, historyResponse] = await Promise.all([
      fetch(profileUrl),
      fetch(quoteUrl),
      fetch(historyUrl)
    ]);

    // 分別處理回傳結果
    if (!profileResponse.ok || !quoteResponse.ok) {
        return response.status(404).json({ error: `找不到即時報價資料: ${symbol}` });
    }
    if (!historyResponse.ok) {
        return response.status(500).json({ error: `獲取歷史資料失敗` });
    }

    const profileData = await profileResponse.json();
    const quoteData = await quoteResponse.json();
    const historyData = await historyResponse.json();

    if (quoteData.c === 0 && !profileData.name) {
       return response.status(404).json({ error: `找不到 Finnhub 資料: ${symbol}` });
    }
    if (historyData['Note']) {
      return response.status(503).json({ error: '已達到 Alpha Vantage API 請求上限' });
    }
    if (!historyData['Time Series (Daily)']) {
      return response.status(404).json({ error: `找不到 Alpha Vantage 歷史資料: ${symbol}` });
    }

    // 將從兩個 API 獲取的資料，整理成我們 App 需要的格式
    const timeSeries = historyData['Time Series (Daily)'];
    
    const processedHistory = Object.entries(timeSeries).slice(0, 30).map(([date, data]) => ({
      date: date,
      open: parseFloat(data['1. open']),
      high: parseFloat(data['2. high']),
      low: parseFloat(data['3. low']),
      close: parseFloat(data['4. close']),
      volume: parseInt(data['5. volume'])
    })).reverse(); // Alpha Vantage 回傳的是時間降序，我們需要升序後再反轉

    const processedData = {
      symbol: symbol,
      name: profileData.name || symbol,
      price: quoteData.c, // Current price from Finnhub
      change: quoteData.d, // Change from Finnhub
      changePercent: quoteData.dp, // Percent change from Finnhub
      high: quoteData.h, // Day's high from Finnhub
      low: quoteData.l, // Day's low from Finnhub
      history: processedHistory.reverse(), // 將歷史資料反轉為時間降序
    };

    response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return response.status(200).json(processedData);

  } catch (error) {
    console.error('handleGetStockData Error:', error);
    return response.status(500).json({ error: '伺服器內部發生錯誤' });
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
