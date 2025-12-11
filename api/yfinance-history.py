"""
Vercel Serverless Function for fetching stock historical data using yfinance
This provides unlimited, free historical stock data without API limits
"""

import json
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import sys
import os

# 嘗試導入 yfinance，如果失敗則返回錯誤
try:
    import yfinance as yf
    import pandas as pd
    YFINANCE_AVAILABLE = True
except ImportError as e:
    YFINANCE_AVAILABLE = False
    IMPORT_ERROR = str(e)

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            # 檢查 yfinance 是否可用
            if not YFINANCE_AVAILABLE:
                self.send_error_response(500, f"yfinance not available: {IMPORT_ERROR}")
                return
                
            # 解析 URL 參數
            parsed_url = urlparse(self.path)
            query_params = parse_qs(parsed_url.query)
            
            symbol = query_params.get('symbol', [None])[0]
            timeframe = query_params.get('timeframe', ['D'])[0]  # D for daily, 5M for 5-minute
            
            if not symbol:
                self.send_error_response(400, "Missing required parameter: symbol")
                return
                
            # 清理股票代號（移除 .US 後綴，yfinance 不需要）
            clean_symbol = symbol.replace('.US', '').replace('.TW', '')
            
            # 根據 timeframe 設置參數
            if timeframe == '5M':
                period = "1d"  # 1天的5分線數據
                interval = "5m"
                max_days = 1
            else:
                period = "1y"   # 1年的日線數據
                interval = "1d"
                max_days = 365
                
            print(f"[{datetime.now().isoformat()}] Fetching yfinance data for {clean_symbol}, timeframe={timeframe}")
            
            # 使用 yfinance 獲取數據
            ticker = yf.Ticker(clean_symbol)
            
            # 獲取歷史數據
            hist_data = ticker.history(
                period=period,
                interval=interval,
                auto_adjust=True,
                prepost=True,
                threads=True
            )
            
            if hist_data.empty:
                print(f"[{datetime.now().isoformat()}] No data found for symbol: {clean_symbol}")
                self.send_error_response(404, f"No historical data found for symbol: {symbol}")
                return
            
            # 轉換數據格式
            history_data = []
            for date_index, row in hist_data.iterrows():
                # 處理日期格式
                if timeframe == '5M':
                    # 5分線保持完整的時間戳
                    date_str = date_index.isoformat()
                else:
                    # 日線只保留日期部分
                    date_str = date_index.strftime('%Y-%m-%d')
                
                history_data.append({
                    'date': date_str,
                    'open': float(row['Open']) if not pd.isna(row['Open']) else 0,
                    'high': float(row['High']) if not pd.isna(row['High']) else 0,
                    'low': float(row['Low']) if not pd.isna(row['Low']) else 0,
                    'close': float(row['Close']) if not pd.isna(row['Close']) else 0,
                    'volume': int(row['Volume']) if not pd.isna(row['Volume']) else 0
                })
            
            # 對於日線數據，確保按日期排序（最新的在前）
            if timeframe != '5M':
                history_data.sort(key=lambda x: x['date'], reverse=True)
            
            # 獲取股票基本信息
            try:
                info = ticker.info
                stock_name = info.get('longName', info.get('shortName', clean_symbol))
            except:
                stock_name = clean_symbol
            
            response_data = {
                'symbol': symbol,
                'name': stock_name,
                'history': history_data,
                'source': 'yfinance',
                'timeframe': timeframe,
                'total_points': len(history_data),
                'timestamp': datetime.now().isoformat()
            }
            
            print(f"[{datetime.now().isoformat()}] Successfully fetched {len(history_data)} data points for {clean_symbol}")
            
            # 發送成功響應
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Cache-Control', 'public, max-age=300')  # 快取5分鐘
            self.end_headers()
            
            response_json = json.dumps(response_data, ensure_ascii=False, indent=2)
            self.wfile.write(response_json.encode('utf-8'))
            
        except Exception as e:
            print(f"[{datetime.now().isoformat()}] Error in yfinance handler: {str(e)}")
            print(f"[{datetime.now().isoformat()}] Error type: {type(e).__name__}")
            import traceback
            traceback.print_exc()
            self.send_error_response(500, f"Internal server error: {str(e)}")
    
    def do_OPTIONS(self):
        """處理 CORS 預檢請求"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def send_error_response(self, status_code, message):
        """發送錯誤響應"""
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        
        error_response = {
            'error': message,
            'status': status_code,
            'timestamp': datetime.now().isoformat(),
            'source': 'yfinance-api'
        }
        
        response_json = json.dumps(error_response, ensure_ascii=False, indent=2)
        self.wfile.write(response_json.encode('utf-8'))