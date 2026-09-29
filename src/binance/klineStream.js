import WebSocket from 'ws';
import EventEmitter from 'events';
import { ENDPOINTS } from '../config/index.js';
import { logger } from '../utils/logger.js';

export class KlineStreamManager extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.symbols = [];
    this.intervals = ['15m', '1h'];
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.pingInterval = null;
    this.isManualClosed = false;
    this.disconnectAlertTimer = null;
    this.disconnectAlertSent = false;
  }

  /**
   * Initialize or update stream subscription
   * @param {string[]} symbols 
   * @param {string[]} intervals 
   */
  start(symbols, intervals = ['15m', '1h']) {
    this.symbols = symbols.map(s => s.toLowerCase());
    this.intervals = intervals;
    this.isManualClosed = false;
    this.connect();
  }

  buildStreamUrl() {
    const streamNames = [];
    for (const sym of this.symbols) {
      for (const interval of this.intervals) {
        streamNames.push(`${sym}@kline_${interval}`);
      }
    }
    return `${ENDPOINTS.ws}/stream?streams=${streamNames.join('/')}`;
  }

  connect() {
    if (this.isManualClosed) return;
    if (this.symbols.length === 0) {
      logger.warn('KlineStream', 'No symbols provided to stream.');
      return;
    }

    const url = this.buildStreamUrl();
    logger.info('KlineStream', `Connecting to Binance Kline Stream with ${this.symbols.length * this.intervals.length} streams...`);

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        logger.info('KlineStream', 'Connected to Binance Kline Stream successfully.');
        this.reconnectAttempts = 0;

        if (this.disconnectAlertSent) {
          this.emit('reconnected_after_disconnect');
          this.disconnectAlertSent = false;
        }
        clearTimeout(this.disconnectAlertTimer);
        this.disconnectAlertTimer = null;

        this.emit('connected');

        // Setup ping every 3 minutes
        clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 3 * 60 * 1000);
      });

      this.ws.on('message', (data) => {
        try {
          const payload = JSON.parse(data.toString());
          if (payload && payload.data && payload.data.e === 'kline') {
            const k = payload.data.k;
            // Only process completed candles
            if (k.x) {
              const candle = {
                symbol: k.s.toUpperCase(),
                interval: k.i,
                openTime: k.t,
                closeTime: k.T,
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
                volume: parseFloat(k.v),
                isClosed: k.x,
              };
              this.emit('candle', candle);
            }
          }
        } catch (err) {
          logger.error('KlineStream', `Failed to parse message: ${err.message}`);
        }
      });

      this.ws.on('error', (err) => {
        logger.error('KlineStream', `WebSocket error: ${err.message}`);
        this.emit('error', err);
      });

      this.ws.on('close', (code, reason) => {
        clearInterval(this.pingInterval);
        if (!this.isManualClosed) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
          logger.warn('KlineStream', `Disconnected (${code} - ${reason}). Reconnecting in ${delay / 1000}s...`);
          this.emit('disconnected');

          // Alert if disconnected for > 2 minutes (PRD Section 13)
          if (!this.disconnectAlertTimer) {
            this.disconnectAlertTimer = setTimeout(() => {
              this.disconnectAlertSent = true;
              this.emit('prolonged_disconnect');
            }, 2 * 60 * 1000);
          }

          setTimeout(() => this.connect(), delay);
        }
      });
    } catch (err) {
      logger.error('KlineStream', `Failed to create WebSocket connection: ${err.message}`);
      setTimeout(() => this.connect(), 5000);
    }
  }

  stop() {
    this.isManualClosed = true;
    clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    logger.info('KlineStream', 'Stream stopped.');
  }

  updateSymbols(symbols) {
    this.symbols = symbols.map(s => s.toLowerCase());
    logger.info('KlineStream', `Updating stream symbols: ${this.symbols.length} pairs.`);
    if (this.ws) {
      this.ws.close(); // Triggers reconnect with updated URL
    }
  }
}

export const klineStream = new KlineStreamManager();
