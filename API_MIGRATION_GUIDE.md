# API 遷移指南

## 問題描述
Financial Modeling Prep (FMP) API 出現穩定性問題，導致生產環境中出現 500 錯誤。

## 解決方案
已將系統重構為使用多數據源架構：
1. **Finnhub API** - 主要用於即時報價和5分線數據
2. **Alpha Vantage API** - 主要用於日線歷史數據（推薦）
3. **Finnhub API** - 作為歷史數據的備用來源

## 需要的環境變數

### 1. Finnhub API （必需）
- 變數名: `FINNHUB_API_KEY`
- 獲取方式: [Finnhub.io](https://finnhub.io/register)
- 免費層級: 每分鐘60次請求
- 用途: 即時報價、公司資訊、5分線數據

### 2. Alpha Vantage API （推薦）
- 變數名: `ALPHA_VANTAGE_API_KEY`
- 獲取方式: [Alpha Vantage](https://www.alphavantage.co/support/#api-key)
- 免費層級: 每分鐘5次請求，每日500次請求
- 用途: 日線歷史數據

## 在 Vercel 中設置環境變數

1. 登入 Vercel Dashboard
2. 進入您的專案設置
3. 點擊 "Environment Variables"
4. 添加以下變數:
   ```
   ALPHA_VANTAGE_API_KEY=your_alpha_vantage_key_here
   ```
5. 重新部署應用

## 備用方案
如果不設置 Alpha Vantage API 密鑰，系統會自動使用 Finnhub 作為歷史數據的來源。但建議設置 Alpha Vantage 以獲得更好的數據質量和穩定性。

## 程式碼更改
- 移除了對 FMP API 的依賴
- 實現了多數據源的降級機制
- 保持了原有的快取策略
- 保持了原有的 API 介面不變

## 測試
部署後可以測試：
```bash
curl "https://kairis.vercel.app/api/get-stock-data?symbol=META.US"
```

應該能正常返回股票數據而不再出現 500 錯誤。
