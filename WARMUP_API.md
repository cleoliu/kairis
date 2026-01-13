# 緩存預熱 API 使用說明

## 概述

這個 API 端點允許 n8n 或其他自動化工具每天定時預先獲取並緩存股票歷史數據，這樣用戶訪問時就能直接從緩存讀取，無需實時調用外部 API。

## API 端點

支持兩種調用方式：

### 方式 1: GET 請求（URL 參數）

```
GET /api/get-stock-data?action=warmup_cache&symbols=AAPL.US,NVDA.US,MSFT.US&secret=YOUR_SECRET
```

### 方式 2: POST 請求（JSON Body）

```
POST /api/get-stock-data
Content-Type: application/json

{
  "action": "warmup_cache",
  "symbols": "AAPL.US,NVDA.US,MSFT.US",
  "secret": "YOUR_SECRET"
}
```

## 參數

- `action` - 必須，值為 `warmup_cache`
- `symbols` - 必須，要預熱的股票代碼列表，用逗號分隔（例如：`AAPL.US,NVDA.US,MSFT.US`）
- `secret` - 必須，驗證密鑰，防止未授權訪問

## 環境變數

需要在 Vercel 環境變數中設置：

```bash
WARMUP_SECRET=your-secure-random-string
```

⚠️ **重要**：請生成一個強密碼作為 `WARMUP_SECRET`，不要使用默認值！

## n8n 設置步驟

### 1. 創建 n8n Workflow

1. 打開 n8n
2. 創建新的 Workflow
3. 添加 **Schedule Trigger** 節點
   - 觸發時間：每天 UTC 時間 13:00（美股開盤前）或 22:00（美股收盤後）
   - Cron 表達式：`0 13 * * *` 或 `0 22 * * *`

### 2. 添加 HTTP Request 節點

配置如下：

- **Method**: GET
- **URL**: `https://kairis.vercel.app/api/get-stock-data`
- **Query Parameters**:
  - `action`: `warmup_cache`
  - `symbols`: `AAPL.US,NVDA.US,MSFT.US,GOOGL.US,AMZN.US,META.US,TSLA.US,BABA.US` （根據你的自選股清單）
  - `secret`: `{{ $env.WARMUP_SECRET }}` （從環境變數讀取）
- **Timeout**: 300000 (5 minutes)

### 3. 測試 Workflow

手動執行 Workflow，檢查是否成功：

```json
{
  "success": true,
  "message": "Cache warmup completed",
  "results": {
    "success": ["AAPL.US", "NVDA.US", "MSFT.US"],
    "failed": [],
    "total": 3
  }
}
```

## 工作原理

1. **n8n 定時觸發**：每天在設定的時間自動執行
2. **批次處理**：每批處理 3 個股票，避免 API rate limit
3. **緩存存儲**：將 90 天的歷史數據存入 Vercel KV
4. **緩存有效期**：7 天（可自動延續）
5. **用戶訪問**：前端優先從緩存讀取，如果緩存不存在才調用 API

## 優勢

✅ **減少 API 調用**：用戶訪問時不需要實時調用外部 API  
✅ **更快的響應速度**：直接從 Redis 緩存讀取  
✅ **節省成本**：減少對免費 API 配額的消耗  
✅ **更高可靠性**：即使外部 API 暫時失敗，也能從緩存提供數據

## 進階配置

### 多時段預熱

如果需要在多個時間點預熱緩存（例如開盤前和收盤後），可以創建兩個 n8n Workflow：

- **開盤前預熱**（UTC 13:00）：確保用戶在交易時段有最新數據
- **收盤後預熱**（UTC 22:00）：在收盤後立即更新當日完整數據

### 動態股票清單

可以在 n8n 中添加一個節點，從 Firebase 或其他來源動態讀取所有用戶的自選股清單，然後自動預熱所有股票。

## 故障排除

### 401 錯誤：未授權
- 檢查 `WARMUP_SECRET` 環境變數是否正確設置
- 確認 n8n 請求中的 `secret` 參數是否正確

### 500 錯誤：API keys 未設定
- 確認 Vercel 環境變數中設置了 `POLYGON_API_KEY` 和 `FINNHUB_API_KEY`

### 部分股票失敗
- 檢查返回的 `results.failed` 陣列
- 確認股票代碼是否正確
- 可能是該股票暫時無法獲取數據

## 監控建議

建議在 n8n 中添加錯誤處理和通知：

1. 如果 API 返回錯誤，發送 Email 或 Slack 通知
2. 記錄每次執行的結果到 Google Sheets 或資料庫
3. 監控 `results.failed` 數量，如果失敗率過高則告警
