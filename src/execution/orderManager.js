import EventEmitter from 'events';
import { binanceClient } from '../binance/client.js';
import { precisionManager } from '../binance/precision.js';
import { positionManager } from './positionManager.js';
import { ocoManager } from './ocoManager.js';
import { userDataStream } from '../binance/userDataStream.js';
import { getRiskConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

class OrderManager extends EventEmitter {
  constructor() {
    super();
    // Pending entry promises: clientOrderId -> { resolve, reject, isFilled }
    this.pendingEntries = new Map();

    // Hook to userDataStream for order fill events
    userDataStream.on('order_filled', (order) => {
      const clientOrderId = order.c;
      if (this.pendingEntries.has(clientOrderId)) {
        logger.info('OrderManager', `Entry order ${clientOrderId} FILLED for ${order.s} @ $${order.L || order.ap}`);
        const entryTracker = this.pendingEntries.get(clientOrderId);
        entryTracker.isFilled = true;
        entryTracker.resolve(order);
        this.pendingEntries.delete(clientOrderId);
      }
    });

    userDataStream.on('order_canceled', (order) => {
      const clientOrderId = order.c;
      if (this.pendingEntries.has(clientOrderId)) {
        logger.warn('OrderManager', `Entry order ${clientOrderId} was CANCELED for ${order.s}`);
        const entryTracker = this.pendingEntries.get(clientOrderId);
        if (!entryTracker.isFilled) {
          entryTracker.reject(new Error(`Order ${clientOrderId} was cancelled.`));
        }
        this.pendingEntries.delete(clientOrderId);
      }
    });
  }

  /**
   * Execute entry signal with Limit order + Timeout fallback to Market
   */
  async executeSignal(signal) {
    const { symbol, signal: direction, entryPrice, stopLossPrice, takeProfitPrice, trailingCallbackRate, strategy } = signal;
    const riskConfig = getRiskConfig();

    logger.info('OrderManager', `Executing ${direction} signal for ${symbol} (Trigger Price: ~$${entryPrice})...`);

    // 1. Prepare leverage and margin type
    const leverage = await positionManager.prepareSymbol(symbol);

    // 2. Calculate position size
    const sizing = positionManager.calculateQuantity(symbol, entryPrice, leverage);
    const quantity = sizing.quantity;

    const side = direction === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';

    // 3. Generate idempotent clientOrderId
    const timestamp = Date.now();
    const limitClientOrderId = `bot-${strategy || 'default'}-entry-${timestamp}`;

    // PRD Section 5: Set limit price at best bid (Long) or best ask (Short) for maker fee & lower slippage
    let targetLimitPrice = entryPrice;
    try {
      const ticker = await binanceClient.getBookTicker(symbol);
      if (ticker) {
        if (direction === 'LONG' && ticker.bidPrice) {
          targetLimitPrice = parseFloat(ticker.bidPrice);
        } else if (direction === 'SHORT' && ticker.askPrice) {
          targetLimitPrice = parseFloat(ticker.askPrice);
        }
      }
    } catch (tickerErr) {
      logger.warn('OrderManager', `Could not fetch bookTicker for ${symbol}, fallback to candle close price: ${tickerErr.message}`);
    }

    const formattedLimitPrice = precisionManager.formatPrice(symbol, targetLimitPrice);

    let filledOrder = null;
    let fallbackToMarket = false;

    try {
      // Place LIMIT entry
      logger.info('OrderManager', `Submitting LIMIT ${side} for ${symbol} qty ${quantity} @ $${formattedLimitPrice} (ClientOrderId: ${limitClientOrderId})...`);
      await binanceClient.createOrder({
        symbol,
        side,
        type: 'LIMIT',
        timeInForce: 'GTC',
        quantity,
        price: formattedLimitPrice,
        newClientOrderId: limitClientOrderId,
      });

      // Wait for fill or timeout
      filledOrder = await this.waitForFillOrTimeout(symbol, limitClientOrderId, riskConfig.limitOrderTimeoutSeconds || 45);
    } catch (err) {
      if (err.message.includes('TIMEOUT')) {
        logger.warn('OrderManager', `Limit order timed out for ${symbol} after ${riskConfig.limitOrderTimeoutSeconds || 45}s. Cancelling and falling back to MARKET...`);
        fallbackToMarket = true;
        try {
          await binanceClient.cancelOrder(symbol, { origClientOrderId: limitClientOrderId });
          logger.info('OrderManager', `Cancelled timed out limit order ${limitClientOrderId}`);
        } catch (cancelErr) {
          logger.warn('OrderManager', `Cancel limit order response: ${cancelErr.message}`);
        }

        // Emit fallback notification
        this.emit('fallback_to_market', { symbol, direction, quantity });

        // Submit MARKET order
        const marketClientOrderId = `bot-${strategy || 'default'}-mkt-${Date.now()}`;
        logger.info('OrderManager', `Submitting fallback MARKET ${side} for ${symbol} qty ${quantity}...`);
        const marketRes = await binanceClient.createOrder({
          symbol,
          side,
          type: 'MARKET',
          quantity,
          newClientOrderId: marketClientOrderId,
        });

        filledOrder = marketRes;
      } else {
        throw err;
      }
    }

    // 4. Determine actual filled price and quantity
    const actualPrice = parseFloat(filledOrder.avgPrice || filledOrder.L || entryPrice);
    const actualQty = parseFloat(filledOrder.cumQty || filledOrder.z || quantity);

    logger.info('OrderManager', `Position entry confirmed for ${symbol} ${direction}: ${actualQty} units @ avg $${actualPrice}`);

    // 5. Submit Protection Orders (SL, TP, Trailing)
    const formattedSLPrice = precisionManager.formatPrice(symbol, stopLossPrice);
    const formattedTPPrice = precisionManager.formatPrice(symbol, takeProfitPrice);
    const formattedActualQty = precisionManager.formatQuantity(symbol, actualQty);

    const slClientOrderId = `bot-sl-${Date.now()}`;
    const tpClientOrderId = `bot-tp-${Date.now()}`;
    const trailingClientOrderId = `bot-tr-${Date.now()}`;

    // Place SL (STOP_MARKET)
    let slOrder = null;
    try {
      slOrder = await binanceClient.createOrder({
        symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        stopPrice: formattedSLPrice,
        quantity: formattedActualQty,
        reduceOnly: 'true',
        newClientOrderId: slClientOrderId,
      });
      logger.info('OrderManager', `Successfully placed STOP_MARKET (SL) for ${symbol} @ $${formattedSLPrice} (OrderId: ${slOrder?.orderId})`);
    } catch (err) {
      logger.error('OrderManager', `Failed to place Stop Loss for ${symbol}: ${err.message}`);
    }

    // Place TP (TAKE_PROFIT_MARKET)
    let tpOrder = null;
    try {
      tpOrder = await binanceClient.createOrder({
        symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: formattedTPPrice,
        quantity: formattedActualQty,
        reduceOnly: 'true',
        newClientOrderId: tpClientOrderId,
      });
      logger.info('OrderManager', `Successfully placed TAKE_PROFIT_MARKET (TP) for ${symbol} @ $${formattedTPPrice} (OrderId: ${tpOrder?.orderId})`);
    } catch (err) {
      logger.error('OrderManager', `Failed to place Take Profit for ${symbol}: ${err.message}`);
    }

    // Place Trailing Stop (TRAILING_STOP_MARKET)
    let trailingOrder = null;
    try {
      trailingOrder = await binanceClient.createOrder({
        symbol,
        side: exitSide,
        type: 'TRAILING_STOP_MARKET',
        quantity: formattedActualQty,
        reduceOnly: 'true',
        callbackRate: trailingCallbackRate,
        newClientOrderId: trailingClientOrderId,
      });
      logger.info('OrderManager', `Successfully placed TRAILING_STOP_MARKET for ${symbol} callback ${trailingCallbackRate}% (OrderId: ${trailingOrder?.orderId})`);
    } catch (err) {
      logger.error('OrderManager', `Failed to place Trailing Stop for ${symbol}: ${err.message}`);
    }

    // Register with OcoManager
    ocoManager.registerProtection(symbol, {
      direction,
      quantity: formattedActualQty,
      entryPrice: actualPrice,
      slOrderId: slOrder?.orderId,
      slClientOrderId,
      tpOrderId: tpOrder?.orderId,
      tpClientOrderId,
      trailingOrderId: trailingOrder?.orderId,
      trailingClientOrderId,
      stopLossPrice: formattedSLPrice,
      takeProfitPrice: formattedTPPrice,
      trailingCallbackRate,
    });
    const tradeResult = {
      symbol,
      direction,
      entryPrice: actualPrice,
      quantity: formattedActualQty,
      leverage,
      margin: sizing.margin,
      stopLossPrice: formattedSLPrice,
      takeProfitPrice: formattedTPPrice,
      trailingCallbackRate,
      fallbackToMarket,
    };

    this.emit('position_opened', tradeResult);
    return tradeResult;
  }

  /**
   * Helper to wait for order fill or timeout
   */
  waitForFillOrTimeout(symbol, clientOrderId, timeoutSec) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        if (this.pendingEntries.has(clientOrderId)) {
          this.pendingEntries.delete(clientOrderId);
          reject(new Error(`TIMEOUT: Order ${clientOrderId} not filled within ${timeoutSec}s`));
        }
      }, timeoutSec * 1000);

      this.pendingEntries.set(clientOrderId, {
        resolve: (order) => {
          clearTimeout(timer);
          resolve(order);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        isFilled: false,
      });
    });
  }

  /**
   * Close a position manually with MARKET order
   */
  async closePositionMarket(symbol) {
    logger.info('OrderManager', `Starting manual market close for ${symbol}...`);
    const positions = await positionManager.getOpenPositions();
    const position = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());

    if (!position || Math.abs(parseFloat(position.positionAmt)) === 0) {
      throw new Error(`Tidak ada posisi terbuka untuk ${symbol}.`);
    }

    const positionAmt = parseFloat(position.positionAmt);
    const side = positionAmt > 0 ? 'SELL' : 'BUY';
    const quantity = precisionManager.formatQuantity(symbol, Math.abs(positionAmt));

    // Cancel existing protection orders first
    logger.info('OrderManager', `Cancelling existing protection orders for ${symbol} before market close...`);
    await binanceClient.cancelAllOpenOrders(symbol);
    ocoManager.removeProtection(symbol);

    // Place Market close order
    const closeClientOrderId = `bot-close-manual-${Date.now()}`;
    logger.info('OrderManager', `Submitting MARKET ${side} close order for ${symbol} qty ${quantity}...`);
    const result = await binanceClient.createOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity,
      reduceOnly: 'true',
      newClientOrderId: closeClientOrderId,
    });

    const closePrice = parseFloat(result.avgPrice || '0');
    logger.info('OrderManager', `Position ${symbol} successfully closed via MARKET order @ $${closePrice}`);

    return {
      symbol,
      side,
      quantity,
      entryPrice: parseFloat(position.entryPrice),
      closePrice,
      unrealizedProfit: parseFloat(position.unRealizedProfit),
    };
  }
}

export const orderManager = new OrderManager();
