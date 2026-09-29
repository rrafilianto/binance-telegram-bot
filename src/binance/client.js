import crypto from 'crypto';
import axios from 'axios';
import { ENV, ENDPOINTS } from '../config/index.js';
import { logger } from '../utils/logger.js';

class BinanceClient {
  constructor() {
    this.apiKey = ENV.BINANCE_API_KEY;
    this.apiSecret = ENV.BINANCE_API_SECRET;
    this.baseURL = ENDPOINTS.rest;
    this.timeOffset = 0; // Difference between local time and Binance server time
    this.isTimeSynced = false;

    this.http = axios.create({
      baseURL: this.baseURL,
      timeout: 15000,
    });
  }

  /**
   * Synchronize local time with Binance server time
   */
  async syncTime() {
    try {
      const response = await this.http.get('/fapi/v1/time');
      const serverTime = response.data.serverTime;
      const localTime = Date.now();
      this.timeOffset = serverTime - localTime;
      this.isTimeSynced = true;
      logger.info('BinanceClient', `Synced server time with Binance. Offset: ${this.timeOffset}ms`);
    } catch (err) {
      logger.warn('BinanceClient', `Failed to sync server time: ${err.message}`);
    }
  }

  getTimestamp() {
    return Date.now() + this.timeOffset;
  }

  sign(queryString) {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * General request wrapper with retries and signature handling
   */
  async request(method, endpoint, params = {}, isSigned = false, retries = 3) {
    if (isSigned && !this.isTimeSynced) {
      await this.syncTime();
    }

    let queryObj = { ...params };

    if (isSigned) {
      queryObj.timestamp = this.getTimestamp();
      queryObj.recvWindow = 5000;
    }

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (this.apiKey) {
      headers['X-MBX-APIKEY'] = this.apiKey;
    }

    let queryString = new URLSearchParams(queryObj).toString();

    if (isSigned) {
      const signature = this.sign(queryString);
      queryString += `&signature=${signature}`;
    }

    let url = endpoint;
    let data = null;

    if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE') {
      if (queryString) {
        url += `?${queryString}`;
      }
    } else {
      data = queryString;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.http({
          method,
          url,
          data,
          headers,
        });
        return response.data;
      } catch (err) {
        const status = err.response?.status;
        const errData = err.response?.data;
        const code = errData?.code;
        const msg = errData?.msg || err.message;

        // Check for timestamp error (-1021) -> re-sync time and retry immediately
        if (code === -1021 && attempt < retries) {
          logger.warn('BinanceClient', `Timestamp out of sync (-1021). Re-syncing time...`);
          await this.syncTime();
          continue;
        }

        // Catch margin type already set (-4046) or position exists (-4068) -> treat as success
        if (code === -4046 || code === -4068) {
          return { code: 200, msg: msg || 'No need to change margin type.' };
        }

        const isTransient =
          status === 429 ||
          (status >= 500 && status < 600) ||
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT';

        if (isTransient && attempt < retries) {
          const delay = Math.pow(2, attempt) * 500;
          logger.warn(
            'BinanceClient',
            `Transient error ${status || err.code} on ${endpoint}. Retrying in ${delay}ms... (Attempt ${attempt}/${retries})`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw new Error(`Binance API Error [${code || status || 'UNKNOWN'}]: ${msg}`);
      }
    }
  }

  // --- Public Endpoints ---

  async ping() {
    return this.request('GET', '/fapi/v1/ping');
  }

  async getExchangeInfo() {
    return this.request('GET', '/fapi/v1/exchangeInfo');
  }

  async getKlines(symbol, interval, limit = 250) {
    return this.request('GET', '/fapi/v1/klines', {
      symbol: symbol.toUpperCase(),
      interval,
      limit,
    });
  }

  async getBookTicker(symbol = null) {
    const params = symbol ? { symbol: symbol.toUpperCase() } : {};
    return this.request('GET', '/fapi/v1/ticker/bookTicker', params);
  }

  async getPremiumIndex(symbol = null) {
    const params = symbol ? { symbol: symbol.toUpperCase() } : {};
    return this.request('GET', '/fapi/v1/premiumIndex', params);
  }

  // --- Signed Endpoints ---

  async getLeverageBracket(symbol = null) {
    const params = symbol ? { symbol: symbol.toUpperCase() } : {};
    return this.request('GET', '/fapi/v1/leverageBracket', params, true);
  }

  async setMarginType(symbol, marginType = 'CROSSED') {
    return this.request(
      'POST',
      '/fapi/v1/marginType',
      {
        symbol: symbol.toUpperCase(),
        marginType: marginType.toUpperCase(),
      },
      true
    );
  }

  async setLeverage(symbol, leverage) {
    return this.request(
      'POST',
      '/fapi/v1/leverage',
      {
        symbol: symbol.toUpperCase(),
        leverage,
      },
      true
    );
  }

  async createOrder(params) {
    logger.info(
      'BinanceClient',
      `Placing order: ${params.symbol} ${params.side} ${params.type} (Qty: ${params.quantity || 'N/A'}, Price: ${params.price || params.stopPrice || 'N/A'}, ClientId: ${params.newClientOrderId || 'N/A'})`
    );
    return this.request('POST', '/fapi/v1/order', params, true);
  }

  async cancelOrder(symbol, { orderId, origClientOrderId }) {
    logger.info(
      'BinanceClient',
      `Cancelling order on ${symbol}: OrderId=${orderId || 'N/A'}, ClientId=${origClientOrderId || 'N/A'}`
    );
    const params = { symbol: symbol.toUpperCase() };
    if (orderId) params.orderId = orderId;
    if (origClientOrderId) params.origClientOrderId = origClientOrderId;
    return this.request('DELETE', '/fapi/v1/order', params, true);
  }

  async cancelAllOpenOrders(symbol) {
    logger.info('BinanceClient', `Cancelling ALL open orders on ${symbol}`);
    return this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol: symbol.toUpperCase() }, true);
  }

  async getOpenOrders(symbol = null) {
    const params = symbol ? { symbol: symbol.toUpperCase() } : {};
    return this.request('GET', '/fapi/v1/openOrders', params, true);
  }

  async getPositionRisk(symbol = null) {
    const params = symbol ? { symbol: symbol.toUpperCase() } : {};
    return this.request('GET', '/fapi/v2/positionRisk', params, true);
  }

  async getBalance() {
    return this.request('GET', '/fapi/v2/balance', {}, true);
  }

  // --- Listen Key (User Data Stream) ---

  async createListenKey() {
    return this.request('POST', '/fapi/v1/listenKey', {}, false);
  }

  async keepAliveListenKey() {
    return this.request('PUT', '/fapi/v1/listenKey', {}, false);
  }

  async closeListenKey() {
    return this.request('DELETE', '/fapi/v1/listenKey', {}, false);
  }
}

export const binanceClient = new BinanceClient();
