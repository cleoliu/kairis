# StockWise App - 產品需求文件 (PRD)

## 1. 產品概述 (Product Overview)

本文件旨在定義一款名為 StockWise 的行動優先網頁應用程式 (SPA)。此 App 的核心目標是為投資者提供一個簡潔、高效的介面，用以追蹤自選的美股與台股、透過多維度技術指標自動掃描交易機會，並結合 AI 智慧解讀，輔助使用者做出更全面的投資決策。

**Live Demo**: https://stock-wise-three.vercel.app/

## 2. 目標用戶 (Target Audience)

- **主要用戶**: 對美股、台股有基本認識，希望透過技術分析與 AI 輔助，提升選股與決策效率的散戶投資者。

- **用戶特徵**:
  - 習慣使用手機進行看盤與分析。
  - 依賴多種技術指標（價格、成交量、動能）進行綜合判斷。
  - 渴望從自選股中快速、自動地發現符合其交易策略的標的。
  - 希望能快速獲取市場資訊與個股新聞。

## 3. 核心功能 (Core Features)

### 3.1 主要介面與導覽

- **設計**: 採用行動裝置優先的深色主題介面，並以固定在底部的頁籤列 (Tab Bar) 作為主要導覽。
- **頁籤**:
  - 自選列表: 預設主頁，用於管理與追蹤個人股票清單。
  - 機會掃描: 用於自動篩選符合特定買賣條件的股票。

### 3.2 自選列表頁 (Watchlist)

#### 3.2.1 市場分頁:

- 提供「美股」和「台股」兩個子分頁，使用者可以輕鬆切換，專注於特定市場的股票列表。預設顯示「美股」。

#### 3.2.2 新增/刪除股票:

- **新增**: 提供「+」按鈕，彈出視窗讓使用者輸入股票代號。系統會根據當前分頁（美股/台股）自動補上 .US 或 .TW 後綴。
- **刪除**: 每張股票卡片右上角提供「x」按鈕。點擊後會彈出確認提示框，防止誤刪。

#### 3.2.3 股票卡片顯示項目:

- **主要資訊**: 股票名稱、代號、即時價格、漲跌金額與百分比。（即時價格 1 分鐘更新一次）
- **次要資訊**: 當日最高價/最低價。
- **技術指標**: 3 日線、5 日線、10 日線價格。如果當前價格低於任一均線，該均線價格後方會顯示星號 ★ 作為壓力提示。（歷史價格 1 天更新一次）

#### 3.2.4 排序與更新:

- **排序**: 列表內的股票會自動依照股票代號的字母/數字順序排列。
- **更新**: 頁面頂部會顯示「最後更新時間」。

### 3.3 機會掃描頁 (Scanner)

#### 3.3.1 市場分頁:

- 同樣提供「美股」和「台股」兩個子分頁，讓機會掃描更有針對性。

#### 3.3.2 機會卡片:

- **佈局**: 重新設計的卡片佈局，左上為股票名稱與代號，右上為即時價格與漲跌幅。
- **判斷原因**: 左下角以列表形式，完整顯示所有觸發此訊號的技術指標條件。
- **力度評分**: 右下角顯示 1-3 分的量化力度評分。

#### 3.3.3 排序:

- 列表會自動依照「力度」由高至低排序，讓最強烈的訊號優先顯示。

#### 3.3.4 力度評估邏輯 (升級版):

- 綜合價格 (RSI, 布林通道)、趨勢 (均線)、動能 (MACD 交叉) 和成交量 (價量關係) 四個面向的數據進行評分。滿足的條件越多，分數越高。

### 3.4 個股詳情頁 (Detail View)

- **設計**: 以全螢幕覆蓋層的方式呈現，左上角提供返回按鈕。
- **核心資訊**: 頂部顯示該股票的即時價格、漲跌幅、當日高低價與成交量。
- **內容分頁**: 提供「分析」、「圖表」、「新聞」三個子分頁。
  - **分析分頁**:
    - 七日價格區間: 以自訂圖示顯示每日價格波動範圍，並在右側標示 {最低價}~{最高價}。
    - 技術指標參考: 以卡片形式呈現 RSI、MACD、布林通道、量價關係等核心指標的當前數值。
    - Gemini AI 智慧解讀: 提供按鈕讓使用者即時生成由 AI 提供的技術面綜合分析，並修正了手機上的跑版問題。
  - **圖表分頁**:
    - K 線圖: 提供專業的 30 日 K 線圖，顯示完整的 OHLC 數據。
    - 週期切換: 提供「日線」與「週線」切換按鈕，讓使用者能從不同時間維度進行分析。
  - **新聞分頁**:
    - 即時新聞: 自動抓取與該股票相關的最新市場新聞。
    - AI 翻譯: 當新聞標題為英文時，會自動呼叫 AI 翻譯成中文，並截斷過長的標題。

## 4. 技術規格與部署

- **前端**: 純 HTML, CSS (Tailwind), Vanilla JavaScript。
- **後端**: [Vercel](https://www.google.com/search?q=https://vercel.com/cleos-projects-5c380de1/stock-wise) 無伺服器函式 (Serverless Functions)。
- **資料庫**: Google [Firebase](https://www.google.com/search?q=https://console.firebase.google.com/u/0/project/stockwise-ad5e9/overview) (Firestore) 用於儲存使用者自選股，並支援匿名登入。
- **API 組合**:
  - [Finnhub](https://finnhub.io/): 用於獲取美股即時報價與公司新聞。
  - [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs/dashboard): 用於獲取穩定的每日歷史 K 線數據。
  - [Gemini API](https://aistudio.google.com/apikey): 用於 AI 智慧解讀與新聞標題翻譯。
- **部署**: 程式碼託管於 [GitHub](https://www.google.com/search?q=https://github.com/cleoliu/StockWise)，並透過 Vercel 進行自動化部署。

## 5. 部署指南

#### 1. 事前準備

請先註冊好以下平台的免費帳號並取得 API 金鑰：

- [GitHub](https://github.com/)
- [Vercel](https://vercel.com/)
- [Google Firebase](https://firebase.google.com/)
- [Finnhub](https://finnhub.io/)
- [Financial Modeling Prep](https://site.financialmodelingprep.com/)
- [Google AI Studio (for Gemini API)](https://aistudio.google.com/)

#### 2. 專案設定

1.  **上傳至 GitHub**: 將 index.html 和包含 get-stock-data.js 的 api 資料夾上傳到您的 GitHub 儲存庫。

2.  **設定 Firebase**:

    - 依照此處的指示建立專案、啟用匿名登入和 Firestore。
    - 設定 Firestore 安全規則，確保用戶只能存取自己的資料。
    - 將您的 firebaseConfig 物件複製並貼到 index.html 中對應的 placeholder 位置。

3.  **部署到 Vercel**:
    - 在 Vercel 上從您的 GitHub 儲存庫匯入專案。
    - 在專案設定的「Environment Variables」中，新增以下三個金鑰：
      - `FINNHUB_API_KEY`
      - `FMP_API_KEY`
      - `GEMINI_API_KEY`
    - 設定 Vercel KV 快取:
      - 「Storage」分頁，選擇「Upstash」>「Upstash for Redis」，點擊「Create」按鈕
      - 選擇「free」方案、選擇鄰近地區
      - 點選「連結專案」，會自動在專案中，加入所有連接 KV 資料庫所需要的環境變數 (例如 KV_URL, KV_REST_API_URL, KV_REST_API_TOKEN 等)。
    - 點擊「Deploy」。

## 6. 未來發展 (Future Roadmap)

- **支援台股 API**: 尋找並整合可靠的台股 API 來源。
- **自訂掃描條件**: 讓使用者可以自訂「機會掃描」的篩選策略。
