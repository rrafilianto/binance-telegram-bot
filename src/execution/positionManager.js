import { binanceClient } from '../binance/client.js';
import { precisionManager } from '../binance/precision.js';
import { userDataStream } from '../binance/userDataStream.js';
import { getRiskConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

class PositionManager {
  constructor() {
    this.leverageCache = new Map(); // symbol -> { maxLeverage, cachedAt }
    this.CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
    this.cachedPositions = null;
    this.lastPositionsFetchTime = 0;
    this.cachedBalance = null;
    this.lastBalanceFetchTime = 0;

    // Listen to real-time User Data Stream WebSocket for Account Updates (positions & balances)
    userDataStream.on('account_update', (accountData) => {
      this.handleAccountUpdate(accountData);
    });
  }

  handleAccountUpdate(accountData) {
    try {
      // 1. Update Positions from WebSocket event
      if (accountData?.P && Array.isArray(accountData.P)) {
        const positions = [];
        for (const p of accountData.P) {
          const amt = parseFloat(p.pa);
          if (Math.abs(amt) > 0) {
            positions.push({
              symbol: p.s.toUpperCase(),
              positionAmt: p.pa,
              entryPrice: p.ep,
              unRealizedProfit: p.up,
              isolatedWallet: p.iw,
              positionSide: p.ps,
            });
          }
        }
        this.cachedPositions = positions;
        this.lastPositionsFetchTime = Date.now();
        logger.info('PositionManager', `Live WebSocket update: Cached positions updated (${positions.length} active).`);
      }

      // 2. Update Balances from WebSocket event
      if (accountData?.B && Array.isArray(accountData.B)) {
        const usdt = accountData.B.find((b) => b.a === 'USDT');
        if (usdt) {
          const walletBalance = parseFloat(usdt.wb || 0);
          const crossWalletBalance = parseFloat(usdt.cw || usdt.wb || 0);
          this.cachedBalance = {
            walletBalance,
            availableBalance: crossWalletBalance,
            unrealizedPnL: 0,
            usedMargin: Math.max(0, walletBalance - crossWalletBalance),
            otherAssets: [],
          };
          this.lastBalanceFetchTime = Date.now();
        }
      }
    } catch (err) {
      logger.warn('PositionManager', `Failed to process WebSocket account_update: ${err.message}`);
    }
  }

  /**
   * Fetch max allowed leverage for a symbol from leverage bracket
   * Re-fetched periodically to adapt to Binance notional bracket updates
   * @param {string} symbol 
   */
  async getMaxLeverage(symbol) {
    const cached = this.leverageCache.get(symbol);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.maxLeverage;
    }

    try {
      const brackets = await binanceClient.getLeverageBracket(symbol);
      let symbolBracket = null;

      if (Array.isArray(brackets)) {
        if (brackets.length > 0 && brackets[0].symbol) {
          symbolBracket = brackets.find((b) => b.symbol === symbol.toUpperCase()) || brackets[0];
        } else if (brackets[0].brackets) {
          symbolBracket = brackets[0];
        }
      }

      const list = symbolBracket?.brackets || [];
      if (list.length > 0) {
        // First bracket usually has the highest initial leverage
        const maxLeverage = Math.max(...list.map((b) => b.initialLeverage || 1));
        this.leverageCache.set(symbol, { maxLeverage, cachedAt: Date.now() });
        return maxLeverage;
      }
    } catch (err) {
      logger.warn('PositionManager', `Failed to fetch leverage bracket for ${symbol}: ${err.message}. Using default 20x.`);
    }

    return 20; // Default fallback
  }

  /**
   * Fetch current funding rate for a symbol
   */
  async getFundingRate(symbol) {
    try {
      const res = await binanceClient.getPremiumIndex(symbol);
      if (res && res.lastFundingRate) {
        return parseFloat(res.lastFundingRate) * 100; // Return in percentage, e.g. 0.01%
      }
    } catch (err) {
      // Ignore
    }
    return 0;
  }

  /**
   * Ensure symbol has Cross margin and max leverage applied
   * @param {string} symbol 
   */
  async prepareSymbol(symbol) {
    const maxLeverage = await this.getMaxLeverage(symbol);

    try {
      await binanceClient.setMarginType(symbol, 'CROSSED');
    } catch (err) {
      // Ignore if margin type is already crossed
    }

    try {
      await binanceClient.setLeverage(symbol, maxLeverage);
      logger.info('PositionManager', `Set ${symbol} leverage to ${maxLeverage}x (Cross).`);
    } catch (err) {
      logger.warn('PositionManager', `Could not set leverage for ${symbol}: ${err.message}`);
    }

    return maxLeverage;
  }

  /**
   * Calculate position quantity based on configured margin per trade and leverage
   * @param {string} symbol 
   * @param {number} entryPrice 
   * @param {number} leverage 
   */
  calculateQuantity(symbol, entryPrice, leverage) {
    const riskConfig = getRiskConfig();
    const margin = riskConfig.marginPerTradeUSDT || 100;
    const notional = margin * leverage;
    const rawQty = notional / entryPrice;

    const formattedQty = precisionManager.formatQuantity(symbol, rawQty);
    const filters = precisionManager.getFilters(symbol);
    const finalNotional = parseFloat(formattedQty) * entryPrice;

    if (parseFloat(formattedQty) <= 0 || finalNotional < filters.notional) {
      throw new Error(
        `Calculated quantity ${formattedQty} (Notional: $${finalNotional.toFixed(2)}) is below minimum required ($${filters.notional}).`
      );
    }

    return {
      margin,
      leverage,
      notional: finalNotional,
      quantity: formattedQty,
    };
  }

  /**
   * Get all currently open positions (from WebSocket cache or throttled REST)
   */
  async getOpenPositions(forceRefresh = false) {
    const now = Date.now();
    // Return cached positions if available and fresh (< 60s) unless forced
    if (!forceRefresh && this.cachedPositions !== null && now - this.lastPositionsFetchTime < 60000) {
      return this.cachedPositions;
    }

    try {
      const positions = await binanceClient.getPositionRisk();
      this.cachedPositions = positions.filter((p) => Math.abs(parseFloat(p.positionAmt)) > 0);
      this.lastPositionsFetchTime = now;
      return this.cachedPositions;
    } catch (err) {
      if (this.cachedPositions !== null) {
        logger.warn('PositionManager', `Using cached open positions (${this.cachedPositions.length}) due to REST error: ${err.message}`);
        return this.cachedPositions;
      }
      logger.error('PositionManager', `Failed to get open positions: ${err.message}`);
      return [];
    }
  }

  /**
   * Get Futures account balances (from WebSocket cache or throttled REST)
   */
  async getBalance(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.cachedBalance !== null && now - this.lastBalanceFetchTime < 60000) {
      return this.cachedBalance;
    }

    try {
      const balances = await binanceClient.getBalance();
      if (!Array.isArray(balances)) {
        return this.cachedBalance;
      }
      const usdt = balances.find((b) => b.asset === 'USDT') || {
        balance: '0',
        availableBalance: '0',
        crossWalletBalance: '0',
        crossUnPnl: '0',
      };

      const walletBalance = parseFloat(usdt.balance || usdt.crossWalletBalance || 0);
      const availableBalance = parseFloat(usdt.availableBalance || 0);
      const unrealizedPnL = parseFloat(usdt.crossUnPnl || 0);
      const usedMargin = Math.max(0, walletBalance - availableBalance);

      const otherAssets = balances.filter(
        (b) => b.asset !== 'USDT' && parseFloat(b.balance) > 0
      );

      this.cachedBalance = {
        walletBalance,
        availableBalance,
        unrealizedPnL,
        usedMargin,
        otherAssets,
        raw: balances,
      };
      this.lastBalanceFetchTime = now;
      return this.cachedBalance;
    } catch (err) {
      if (this.cachedBalance !== null) {
        logger.warn('PositionManager', `Using cached balance due to REST error: ${err.message}`);
        return this.cachedBalance;
      }
      logger.error('PositionManager', `Failed to get balance from Binance: ${err.message}`);
      throw err;
    }
  }
}

export const positionManager = new PositionManager();
