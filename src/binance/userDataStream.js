import WebSocket from 'ws';
import EventEmitter from 'events';
import { binanceClient } from './client.js';
import { ENDPOINTS } from '../config/index.js';
import { logger } from '../utils/logger.js';

export class UserDataStreamManager extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.listenKey = null;
    this.keepAliveInterval = null;
    this.pingInterval = null;
    this.reconnectAttempts = 0;
    this.isManualClosed = false;
    this.disconnectAlertTimer = null;
    this.disconnectAlertSent = false;
  }

  async start() {
    this.isManualClosed = false;
    await this.initListenKeyAndConnect();
  }

  async initListenKeyAndConnect() {
    try {
      const res = await binanceClient.createListenKey();
      this.listenKey = res.listenKey;
      logger.info('UserDataStream', `Obtained listenKey: ${this.listenKey.substring(0, 10)}...`);

      // Keepalive listenKey every 25 minutes
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = setInterval(async () => {
        try {
          await binanceClient.keepAliveListenKey();
          logger.info('UserDataStream', 'Successfully refreshed listenKey keep-alive.');
        } catch (err) {
          logger.error('UserDataStream', `Failed to keep listenKey alive: ${err.message}`);
        }
      }, 25 * 60 * 1000);

      this.connect();
    } catch (err) {
      logger.error('UserDataStream', `Failed to initialize listenKey: ${err.message}`);
      let retryDelay = 10000;
      if (binanceClient.bannedUntil && binanceClient.bannedUntil > Date.now()) {
        retryDelay = Math.min(binanceClient.bannedUntil - Date.now() + 1000, 5 * 60 * 1000);
      }
      setTimeout(() => this.initListenKeyAndConnect(), retryDelay);
    }
  }

  connect() {
    if (this.isManualClosed || !this.listenKey) return;

    const url = `${ENDPOINTS.ws}/ws/${this.listenKey}`;
    logger.info('UserDataStream', 'Connecting to User Data Stream WebSocket...');

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        logger.info('UserDataStream', 'Connected to User Data Stream successfully.');
        this.reconnectAttempts = 0;

        if (this.disconnectAlertSent) {
          this.emit('reconnected_after_disconnect');
          this.disconnectAlertSent = false;
        }
        clearTimeout(this.disconnectAlertTimer);
        this.disconnectAlertTimer = null;

        this.emit('connected');

        clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 3 * 60 * 1000);
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          const eventType = event.e;

          if (eventType === 'ORDER_TRADE_UPDATE') {
            const order = event.o;
            logger.info(
              'UserDataStream',
              `Order Event [${order.s}]: ${order.S} ${order.o} -> Status: ${order.X} (ClientOrderId: ${order.c}, OrderId: ${order.i})`
            );
            this.emit('order_update', order);

            if (order.X === 'FILLED') {
              this.emit('order_filled', order);
            } else if (order.X === 'CANCELED' || order.X === 'EXPIRED') {
              this.emit('order_canceled', order);
            }
          } else if (eventType === 'ACCOUNT_UPDATE') {
            logger.info('UserDataStream', `Account Update Event received (${event.a?.m || 'MARGIN_UPDATE'})`);
            this.emit('account_update', event.a);
          } else if (eventType === 'listenKeyExpired') {
            logger.warn('UserDataStream', 'listenKey expired from server. Re-obtaining...');
            this.ws.close();
          }
        } catch (err) {
          logger.error('UserDataStream', `Failed to parse message: ${err.message}`);
        }
      });

      this.ws.on('error', (err) => {
        logger.error('UserDataStream', `WebSocket error: ${err.message}`);
        this.emit('error', err);
      });

      this.ws.on('close', (code, reason) => {
        clearInterval(this.pingInterval);
        if (!this.isManualClosed) {
          this.reconnectAttempts++;
          const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 30000);
          logger.warn('UserDataStream', `Disconnected (${code} - ${reason}). Reconnecting in ${delay / 1000}s...`);
          this.emit('disconnected');

          if (!this.disconnectAlertTimer) {
            this.disconnectAlertTimer = setTimeout(() => {
              this.disconnectAlertSent = true;
              this.emit('prolonged_disconnect');
            }, 2 * 60 * 1000);
          }

          setTimeout(() => this.initListenKeyAndConnect(), delay);
        }
      });
    } catch (err) {
      logger.error('UserDataStream', `Connection error: ${err.message}`);
      setTimeout(() => this.initListenKeyAndConnect(), 5000);
    }
  }

  stop() {
    this.isManualClosed = true;
    clearInterval(this.keepAliveInterval);
    clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    if (this.listenKey) {
      binanceClient.closeListenKey().catch(() => {});
      this.listenKey = null;
    }
    logger.info('UserDataStream', 'Stream stopped.');
  }
}

export const userDataStream = new UserDataStreamManager();
