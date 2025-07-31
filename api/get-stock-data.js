// Vercel Serverless Function
// 檔案必須放在專案的 /api/ 資料夾下
// 檔名即為 API 路徑，例如 /api/get-stock-data

export default async function handler(request, response) {
  // 根據請求的方法 (GET 或 POST) 決定執行哪個功能
  if (request.method === 'GET') {
    return handleGetStockData(request, response);
  } else if (request.method === 'POST') {
    return handleGeminiAnalysis(request, response);
  } else {
    // 如果是其他類型的請求，回傳錯誤
    response.setHeader('Allow', ['GET', 'POST']);
    return response.status(405).end(`Method ${request.method} Not Allowed`);
  }
}

// 處理從 Alpha Vantage 獲取股價資料的邏輯
async function handleGetStockData(request, response) {
  try {
    const { symbol } = request.query;
    if (!symbol) {
      return response.status(400).json({ error: '必須提供股票代號' });
    }

    const alphaVantageApiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!alphaVantageApiKey) {
      return response.status(500).json({ error: 'ALPHA_VANTAGE_API_KEY 未設定' });
    }

    const quoteUrl = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${alphaVantageApiKey}`;
    const historyUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${alphaVantageApiKey}`;

    const [quoteResponse, historyResponse] = await Promise.all([
      fetch(quoteUrl),
      fetch(historyUrl)
    ]);

    if (!quoteResponse.ok || !historyResponse.ok) {
      throw new Error('從 Alpha Vantage 獲取資料失敗');
    }

    const quoteData = await quoteResponse.json();
    const historyData = await historyResponse.json();

    if (quoteData['Note'] || historyData['Note']) {
      return response.status(503).json({ error: '已達到 Alpha Vantage API 請求上限' });
    }
    if (!quoteData['Global Quote'] || Object.keys(quoteData['Global Quote']).length === 0) {
      return response.status(404).json({ error: `找不到報價資料: ${symbol}` });
    }
    if (!historyData['Time Series (Daily)']) {
      return response.status(404).json({ error: `找不到歷史資料: ${symbol}` });
    }

    const globalQuote = quoteData['Global Quote'];
    const timeSeries = historyData['Time Series (Daily)'];
    
    const processedHistory = Object.entries(timeSeries).slice(0, 30).map(([date, data]) => ({
      date: date,
      open: parseFloat(data['1. open']),
      high: parseFloat(data['2. high']),
      low: parseFloat(data['3. low']),
      close: parseFloat(data['4. close']),
      volume: parseInt(data['5. volume'])
    }));

    const processedData = {
      symbol: globalQuote['01. symbol'],
      price: parseFloat(globalQuote['05. price']),
      change: parseFloat(globalQuote['09. change']),
      changePercent: parseFloat(globalQuote['10. change percent'].replace('%', '')),
      high: parseFloat(globalQuote['03. high']),
      low: parseFloat(globalQuote['04. low']),
      history: processedHistory,
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
