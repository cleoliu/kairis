#!/usr/bin/env node

// Test script for local API functionality
require('dotenv').config({ path: './.env.local' });

// Mock Vercel KV for local testing
const mockKv = {
  get: async (key) => {
    console.log(`[Mock KV] Getting key: ${key}`);
    return null; // Always return null to force fresh API calls
  },
  set: async (key, value, options) => {
    console.log(`[Mock KV] Setting key: ${key}`, options);
    return true;
  }
};

// Replace the kv import with our mock
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === '@vercel/kv') {
    return { kv: mockKv };
  }
  return originalRequire.apply(this, arguments);
};

// Import the API handler
const apiHandler = require('./api/get-stock-data.js').default;

// Mock request and response objects
const mockRequest = {
  method: 'GET',
  query: {
    symbol: 'BABA.US'
  }
};

const mockResponse = {
  status: function(code) {
    this.statusCode = code;
    return this;
  },
  json: function(data) {
    console.log(`\n=== API Response (${this.statusCode}) ===`);
    console.log(JSON.stringify(data, null, 2));
    return this;
  },
  setHeader: function(name, value) {
    console.log(`[Header] ${name}: ${value}`);
  }
};

console.log('Testing API with BABA.US...\n');
console.log('Environment variables:');
console.log('- FINNHUB_API_KEY:', !!process.env.FINNHUB_API_KEY);
console.log('- ALPHA_VANTAGE_API_KEY:', !!process.env.ALPHA_VANTAGE_API_KEY);
console.log('- GEMINI_API_KEY:', !!process.env.GEMINI_API_KEY);
console.log();

// Run the test
apiHandler(mockRequest, mockResponse).catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});