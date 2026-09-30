import EventEmitter from 'events';
import { binanceClient } from '../binance/client.js';
import { logger } from '../utils/logger.js';

class OcoManager extends EventEmitter {
  constructor() {
    super();
    // symbol -> { symbol, side, entryPrice, quantity, slOrderId, tpOrderId, trailingOrderId, slClientOrderId, tpClientOrderId, trailingClientOrderId }
    this.trackedPositions = new Map();
  }

  /**
   * Register exit orders for a position
   */
  registerProtection(symbol, protectionData) {
    this.trackedPositions.set(symbol.toUpperCase(), {
      ...protectionData,
      symbol: symbol.toUpperCase(),
      createdAt: Date.now(),
    });
    logger.info('OcoManager', `Registered SL/TP/Trailing protection for ${symbol}:`, {
      SL: protectionData.slClientOrderId || protectionData.slOrderId,
      TP: protectionData.tpClientOrderId || protectionData.tpOrderId,
      Trailing: protectionData.trailingClientOrderId || protectionData.trailingOrderId,
    });
  }

  getProtection(symbol) {
    return this.trackedPositions.get(symbol.toUpperCase());
  }

  removeProtection(symbol) {
    this.trackedPositions.delete(symbol.toUpperCase());
  }

  /**
   * Handle order filled event from User Data Stream
   * @param {Object} order - ORDER_TRADE_UPDATE payload 'o'
   */
  async handleOrderFilled(order) {
    const symbol = order.s.toUpperCase();
    const clientOrderId = order.c;
    const orderId = order.i;
    const protection = this.trackedPositions.get(symbol);

    if (!protection) return;

    let exitType = null;
    if (clientOrderId === protection.slClientOrderId || orderId === protection.slOrderId) {
      exitType = 'STOP_LOSS';
    } else if (clientOrderId === protection.tpClientOrderId || orderId === protection.tpOrderId) {
      exitType = 'TAKE_PROFIT';
    } else if (clientOrderId === protection.trailingClientOrderId || orderId === protection.trailingOrderId) {
      exitType = 'TRAILING_STOP';
    }

    if (exitType) {
      logger.info('OcoManager', `⚡ Exit triggered: ${exitType} FILLED for ${symbol} @ $${order.L || order.ap}. Auto-cancelling remaining exit orders...`);
      this.removeProtection(symbol);

      try {
        await binanceClient.cancelAllOpenOrders(symbol);
        logger.info('OcoManager', `Successfully cancelled remaining exit orders for ${symbol}.`);
      } catch (err) {
        logger.error('OcoManager', `Failed to cancel remaining orders for ${symbol}: ${err.message}`);
      }

      this.emit('position_closed', {
        symbol,
        exitType,
        clientOrderId,
        orderId,
        price: parseFloat(order.L || order.ap || order.sp || '0'),
        realizedProfit: parseFloat(order.rp || '0'),
        commission: parseFloat(order.n || '0'),
        commissionAsset: order.N || 'USDT',
        time: order.T || Date.now(),
      });
    }
  }

  /**
   * Reconcile active positions with Binance API
   * Reconstructs in-memory tracking on startup and cleans up orphaned orders
   */
  async reconcile() {
    if (binanceClient.bannedUntil && Date.now() < binanceClient.bannedUntil) {
      logger.warn('OcoManager', 'Reconciliation skipped: Binance client is currently in rate-limit/ban cooldown.');
      return;
    }

    try {
      const positions = await binanceClient.getPositionRisk();
      const openPositions = new Map();

      for (const pos of positions) {
        const amt = parseFloat(pos.positionAmt);
        if (Math.abs(amt) > 0) {
          openPositions.set(pos.symbol.toUpperCase(), pos);
        }
      }

      const openOrders = await binanceClient.getOpenOrders();

      // 1. Reconstruct tracking for open positions (crucial on startup/restart)
      for (const [symbol, pos] of openPositions) {
        if (!this.trackedPositions.has(symbol)) {
          const symbolOrders = openOrders.filter((o) => o.symbol.toUpperCase() === symbol);
          const slOrder = symbolOrders.find((o) => o.type === 'STOP_MARKET' || o.clientOrderId?.includes('-sl-'));
          const tpOrder = symbolOrders.find((o) => o.type === 'TAKE_PROFIT_MARKET' || o.clientOrderId?.includes('-tp-'));
          const trailingOrder = symbolOrders.find((o) => o.type === 'TRAILING_STOP_MARKET' || o.clientOrderId?.includes('-tr-'));

          if (slOrder || tpOrder || trailingOrder) {
            this.registerProtection(symbol, {
              direction: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
              quantity: Math.abs(parseFloat(pos.positionAmt)).toString(),
              entryPrice: parseFloat(pos.entryPrice),
              slOrderId: slOrder?.orderId,
              slClientOrderId: slOrder?.clientOrderId,
              tpOrderId: tpOrder?.orderId,
              tpClientOrderId: tpOrder?.clientOrderId,
              trailingOrderId: trailingOrder?.orderId,
              trailingClientOrderId: trailingOrder?.clientOrderId,
              stopLossPrice: slOrder?.stopPrice,
              takeProfitPrice: tpOrder?.stopPrice,
            });
            logger.info('OcoManager', `Reconstructed protection tracking from exchange orders for ${symbol}.`);
          }
        }
      }

      // 2. Safety Net: Check tracked positions against Binance
      for (const [symbol] of this.trackedPositions) {
        if (!openPositions.has(symbol)) {
          logger.warn('OcoManager', `Safety Net: Position ${symbol} is closed on Binance. Cancelling remaining exit orders...`);
          try {
            await binanceClient.cancelAllOpenOrders(symbol);
          } catch (err) {
            logger.error('OcoManager', `Failed to clean up orders for ${symbol}: ${err.message}`);
          }
          this.removeProtection(symbol);
        }
      }

      // 3. Cancel any orphan bot orders where position is already closed
      for (const order of openOrders) {
        const symbol = order.symbol.toUpperCase();
        if (!openPositions.has(symbol) && order.clientOrderId?.startsWith('bot-')) {
          logger.warn('OcoManager', `Found orphan bot order ${order.clientOrderId} for closed position ${symbol}. Cancelling...`);
          try {
            await binanceClient.cancelOrder(symbol, { orderId: order.orderId });
          } catch (err) {
            logger.error('OcoManager', `Failed to cancel orphan order: ${err.message}`);
          }
        }
      }

      logger.info('OcoManager', `Reconciliation completed: ${openPositions.size} open positions, ${this.trackedPositions.size} tracked positions, ${openOrders.length} exchange orders.`);
    } catch (err) {
      logger.error('OcoManager', `Error during reconciliation: ${err.message}`);
    }
  }
}

export const ocoManager = new OcoManager();
