// 共用的 yfinance 邏輯 - 直接在 JavaScript 中實現 yfinance 的功能
// 使用與 yfinance-history.py 相同的 Yahoo Finance API

async function getYfinanceHistoryData(cleanSymbol, timeframe = 'D') {
  try {
    console.log(`[${new Date().toISOString()}] Fetching yfinance data for ${cleanSymbol}, timeframe=${timeframe}`);
    
    // 計算時間範圍 (與 yfinance-history.py 保持一致)
    const now = Math.floor(Date.now() / 1000);
    let period1, period2, interval;
    
    if (timeframe === '5M') {
      period1 = now - (5 * 24 * 60 * 60); // 5天前
      period2 = now;
      interval = '5m';
    } else {
      period1 = now - (730 * 24 * 60 * 60); // 2年前 (730天)
      period2 = now;
      interval = '1d';
    }
    
    // 使用與 yfinance Python 庫相同的 Yahoo Finance API 端點
    // 先嘗試 query2，失敗則嘗試 query1
    const yahooUrls = [
      `https://query2.finance.yahoo.com/v8/finance/chart/${cleanSymbol}?period1=${period1}&period2=${period2}&interval=${interval}&includePrePost=true&includeAdjustedClose=true`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${cleanSymbol}?period1=${period1}&period2=${period2}&interval=${interval}&includePrePost=true&includeAdjustedClose=true`
    ];
    
    console.log(`[${new Date().toISOString()}] Fetching from Yahoo Finance: ${cleanSymbol}`);
    
    let response;
    let lastError;
    
    // 嘗試多個 Yahoo Finance 端點
    for (const yahooUrl of yahooUrls) {
      try {
        response = await fetch(yahooUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Referer': 'https://finance.yahoo.com/',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site'
          }
        });
        
        if (response.ok) {
          console.log(`[${new Date().toISOString()}] Successfully connected to ${yahooUrl}`);
          break; // 成功就跳出循環
        } else {
          console.warn(`[${new Date().toISOString()}] ${yahooUrl} returned ${response.status}`);
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (fetchError) {
        console.warn(`[${new Date().toISOString()}] Failed to fetch from ${yahooUrl}:`, fetchError.message);
        lastError = fetchError;
        continue; // 嘗試下一個 URL
      }
    }
    
    // 如果所有 URL 都失敗
    if (!response || !response.ok) {
      throw lastError || new Error('All Yahoo Finance endpoints failed');
    }
    
    const data = await response.json();
    
    // 檢查 Yahoo Finance API 回應結構
    if (!data.chart || !data.chart.result || !data.chart.result[0]) {
      console.error('Invalid Yahoo Finance response structure:', data);
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
      console.error('No data in Yahoo Finance response:', { timestamps, quotes });
      throw new Error('No historical data found in Yahoo Finance response');
    }
    
    // 轉換資料格式 (與 yfinance-history.py 相同)
    const history = [];
    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const open = quotes.open?.[i];
      const high = quotes.high?.[i];
      const low = quotes.low?.[i];
      const close = adjClose?.[i] || quotes.close?.[i]; // 使用調整後收盤價
      const volume = quotes.volume?.[i];
      
      // 跳過無效資料點
      if (close === null || close === undefined || isNaN(close)) {
        continue;
      }
      
      const date = new Date(timestamp * 1000);
      
      history.push({
        date: timeframe === '5M' ? date.toISOString() : date.toISOString().split('T')[0],
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
    
    console.log(`[${new Date().toISOString()}] ✅ yfinance success: ${history.length} data points for ${cleanSymbol}`);
    
    // 獲取股票名稱
    const stockName = result.meta?.longName || result.meta?.shortName || cleanSymbol;
    
    return {
      symbol: cleanSymbol,
      name: stockName,
      history: history,
      source: 'yfinance-js',
      timeframe: timeframe,
      total_points: history.length,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] yfinance error for ${cleanSymbol}:`, error.message);
    throw error;
  }
}

module.exports = { getYfinanceHistoryData };