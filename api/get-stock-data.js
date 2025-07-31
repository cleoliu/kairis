// Vercel Serverless Function
// 檔案必須放在專案的 /api/ 資料夾下
// 檔名即為 API 路徑，例如 /api/get-stock-data

export default async function handler(request, response) {
  try {
    // 1. 從前端請求的 URL 中獲取股票代號
    // 例如: /api/get-stock-data?symbol=AAPL.US
    const { symbol } = request.query;
    if (!symbol) {
      return response.status(400).json({ error: '必須提供股票代號' });
    }

    // 2. 從 Vercel 的環境變數中安全地讀取您的 API 金鑰
    // 部署時需要在 Vercel 儀表板設定這個變數
    const alphaVantageApiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!alphaVantageApiKey) {
        // 如果伺服器沒有設定金鑰，回傳錯誤
        return response.status(500).json({ error: 'API 金鑰未設定' });
    }

    // 3. 準備並行發送兩個請求到 Alpha Vantage API
    //    - GLOBAL_QUOTE: 獲取最新的報價 (價格、漲跌幅等)
    //    - TIME_SERIES_DAILY: 獲取每日的歷史 K 線數據
    const quoteUrl = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${alphaVantageApiKey}`;
    const historyUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${alphaVantageApiKey}`;

    // 使用 Promise.all 來同時發送兩個請求，以提高效率
    const [quoteResponse, historyResponse] = await Promise.all([
      fetch(quoteUrl),
      fetch(historyUrl)
    ]);

    // 檢查 API 請求是否成功
    if (!quoteResponse.ok || !historyResponse.ok) {
        throw new Error('從 Alpha Vantage 獲取資料失敗');
    }

    const quoteData = await quoteResponse.json();
    const historyData = await historyResponse.json();

    // 檢查 Alpha Vantage 是否因為達到請求上限而回傳提示訊息
    if (quoteData['Note'] || historyData['Note']) {
        return response.status(503).json({ error: '已達到 Alpha Vantage API 請求上限，請稍後再試。' });
    }
    // 檢查回傳的資料是否為空
    if (!quoteData['Global Quote'] || Object.keys(quoteData['Global Quote']).length === 0) {
        return response.status(404).json({ error: `找不到報價資料: ${symbol}` });
    }
     if (!historyData['Time Series (Daily)']) {
        return response.status(404).json({ error: `找不到歷史資料: ${symbol}` });
    }

    // 4. 將從 API 獲取的原始資料，整理成我們 App 需要的乾淨格式
    const globalQuote = quoteData['Global Quote'];
    const timeSeries = historyData['Time Series (Daily)'];
    
    // 將歷史資料轉換為陣列，並只取最近 30 天
    const processedHistory = Object.entries(timeSeries).slice(0, 30).map(([date, data]) => ({
        date: date,
        open: parseFloat(data['1. open']),
        high: parseFloat(data['2. high']),
        low: parseFloat(data['3. low']),
        close: parseFloat(data['4. close']),
        volume: parseInt(data['5. volume'])
    }));

    // 組合最終要回傳給前端的資料物件
    const processedData = {
        symbol: globalQuote['01. symbol'],
        price: parseFloat(globalQuote['05. price']),
        change: parseFloat(globalQuote['09. change']),
        changePercent: parseFloat(globalQuote['10. change percent'].replace('%', '')),
        high: parseFloat(globalQuote['03. high']),
        low: parseFloat(globalQuote['04. low']),
        history: processedHistory,
        // 您也可以在這裡加入 pe 等其他從 API 獲取的資料
    };

    // 5. 將整理好的資料以 JSON 格式回傳給前端
    // 設定 Cache-Control 標頭，讓 Vercel 快取此回應 60 秒，有助於節省 API 用量
    response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    response.status(200).json(processedData);

  } catch (error) {
    // 如果過程中發生任何錯誤，記錄錯誤並回傳一個通用的伺服器錯誤訊息
    console.error(error);
    response.status(500).json({ error: '伺服器內部發生錯誤' });
  }
}
