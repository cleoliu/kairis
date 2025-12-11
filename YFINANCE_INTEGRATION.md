# yfinance 整合說明

## 概述

本專案已整合 yfinance 作為歷史股票資料的主要來源，大幅改善了系統的可靠性和效能。

## 新架構

### 資料來源優先順序

1. **yfinance** (主要來源)
   - ✅ 完全免費，無 API key 需求
   - ✅ 無請求次數限制
   - ✅ 無 rate limit
   - ✅ 資料來源：Yahoo Finance
   - ✅ 支援全球主要交易所

2. **Twelve Data** (備用來源 #1)
   - ⚠️ 有 API 限制和 rate limit
   - 已實現智能 rate limit 控制
   - 支援主要和備用 API key

3. **Finnhub** (備用來源 #2)
   - ⚠️ 有 API 限制
   - 用於 5分線資料和最終備用

4. **模擬資料** (最後備用)
   - 基於當前報價產生30天歷史資料
   - 確保系統永不失敗

### API 端點

#### 新增端點
- `/api/yfinance-history.py?symbol=AAPL&timeframe=D` - 直接從 yfinance 獲取歷史資料

#### 現有端點
- `/api/get-stock-data?symbol=AAPL` - 主要 API，現在優先使用 yfinance
- `/api/get-stock-data?action=api_status` - API 狀態監控，包含 yfinance 狀態

## 技術實現

### Python Runtime
使用 Vercel Python runtime 執行 yfinance：
- Python 3.9
- 依賴：yfinance, pandas, numpy, requests

### 快取策略
- **日線資料**：快取 7 天
- **5分線資料**：快取 1 小時
- **全局共享快取**：所有用戶共用歷史資料

### 錯誤處理
完整的 fallback 機制確保：
- yfinance 失敗 → 嘗試 Twelve Data
- Twelve Data 失敗 → 嘗試 Finnhub  
- 全部失敗 → 產生模擬資料

## 效能改善

### 前後對比
| 項目 | 之前 | 現在 |
|------|------|------|
| API 請求限制 | 8 requests/minute | 無限制 |
| Rate limit | 經常遇到 | 幾乎不會 |
| 資料完整性 | 偶爾只有1天資料 | 始終有完整歷史 |
| 系統穩定性 | 依賴多個付費 API | 主要依賴免費服務 |

### 監控
使用 `/api/get-stock-data?action=api_status` 監控：
```json
{
  "apiStatus": {
    "yfinance": {
      "working": true,
      "lastError": null,
      "lastUsed": "2024-12-11T..."
    }
  },
  "environment": {
    "YFINANCE_AVAILABLE": true
  }
}
```

## 部署注意事項

### 必要文件
- `requirements.txt` - Python 依賴
- `vercel.json` - Vercel 配置
- `api/yfinance-history.py` - Python 端點

### 環境變數
- yfinance 不需要任何 API key
- Twelve Data 和 Finnhub keys 變為可選（僅用作備用）

## 測試

### 手動測試
```bash
# 測試 yfinance 端點
curl "https://your-domain.vercel.app/api/yfinance-history?symbol=AAPL&timeframe=D"

# 測試完整 API
curl "https://your-domain.vercel.app/api/get-stock-data?symbol=AAPL"

# 檢查狀態
curl "https://your-domain.vercel.app/api/get-stock-data?action=api_status"
```

## 問題排查

### 常見問題
1. **Python 模組未找到**：檢查 `requirements.txt` 和 `vercel.json`
2. **yfinance 回傳空資料**：某些股票代號可能不存在，會自動 fallback
3. **CORS 錯誤**：已在 Python 端點配置 CORS headers

### 日誌監控
所有 API 調用都有詳細日誌，包括：
- yfinance 成功/失敗記錄
- Fallback API 使用記錄
- 效能和資料量統計

## 結論

yfinance 整合大幅提升了系統的穩定性和效能，同時降低了對付費 API 的依賴。現在系統可以：
- 處理無限量的歷史資料請求
- 避免 rate limit 問題
- 提供更穩定的用戶體驗
- 降低運營成本