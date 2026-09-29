/**
 * Helper to handle Binance Futures symbol precision rules (LOT_SIZE, PRICE_FILTER, MIN_NOTIONAL)
 */

class PrecisionManager {
  constructor() {
    this.symbolFilters = new Map();
  }

  /**
   * Populate cache from Binance exchangeInfo response
   * @param {Array} symbolsArray 
   */
  loadExchangeInfo(symbolsArray) {
    if (!Array.isArray(symbolsArray)) return;

    for (const item of symbolsArray) {
      const symbol = item.symbol;
      const lotSize = item.filters.find(f => f.filterType === 'LOT_SIZE') || {};
      const priceFilter = item.filters.find(f => f.filterType === 'PRICE_FILTER') || {};
      const minNotional = item.filters.find(f => f.filterType === 'MIN_NOTIONAL') || {};

      const stepSizeStr = lotSize.stepSize || '0.001';
      const tickSizeStr = priceFilter.tickSize || '0.01';

      this.symbolFilters.set(symbol, {
        stepSize: parseFloat(stepSizeStr),
        stepDecimals: this.getDecimals(stepSizeStr),
        minQty: parseFloat(lotSize.minQty || '0.001'),
        maxQty: parseFloat(lotSize.maxQty || '1000000'),
        tickSize: parseFloat(tickSizeStr),
        tickDecimals: this.getDecimals(tickSizeStr),
        minPrice: parseFloat(priceFilter.minPrice || '0.01'),
        maxPrice: parseFloat(priceFilter.maxPrice || '1000000'),
        notional: parseFloat(minNotional.notional || '5'),
      });
    }
  }

  getFilters(symbol) {
    return this.symbolFilters.get(symbol) || {
      stepSize: 0.001,
      stepDecimals: 3,
      minQty: 0.001,
      maxQty: 1000000,
      tickSize: 0.01,
      tickDecimals: 2,
      minPrice: 0.01,
      maxPrice: 1000000,
      notional: 5,
    };
  }

  /**
   * Determine decimal places of a step/tick size string or number
   */
  getDecimals(val) {
    const str = typeof val === 'string' ? val : val.toString();
    if (str.includes('e-')) {
      const parts = str.split('e-');
      return parseInt(parts[1], 10);
    }
    const dotIndex = str.indexOf('.');
    return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
  }

  /**
   * Round down quantity based on stepSize (floor to prevent LOT_SIZE error and notional overshoot)
   */
  formatQuantity(symbol, quantity) {
    const { stepSize, stepDecimals, minQty, maxQty } = this.getFilters(symbol);
    let qty = Math.floor(quantity / stepSize) * stepSize;

    if (qty < minQty) {
      qty = 0; // Below minimum quantity
    } else if (qty > maxQty) {
      qty = maxQty;
    }

    return qty.toFixed(stepDecimals);
  }

  /**
   * Round price to nearest tickSize
   */
  formatPrice(symbol, price) {
    const { tickSize, tickDecimals } = this.getFilters(symbol);
    const rounded = Math.round(price / tickSize) * tickSize;
    return rounded.toFixed(tickDecimals);
  }
}

export const precisionManager = new PrecisionManager();
