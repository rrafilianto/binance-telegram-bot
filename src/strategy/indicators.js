import { EMA, RSI, MACD, ATR } from 'technicalindicators';

/**
 * Technical Indicators utility
 */
export class IndicatorCalculator {
  /**
   * Calculate EMA for a given period
   * @param {number[]} values 
   * @param {number} period 
   * @returns {number[]}
   */
  static calculateEMA(values, period) {
    if (!values || values.length < period) return [];
    return EMA.calculate({ period, values });
  }

  /**
   * Calculate RSI
   * @param {number[]} values 
   * @param {number} period 
   * @returns {number[]}
   */
  static calculateRSI(values, period = 14) {
    if (!values || values.length <= period) return [];
    return RSI.calculate({ period, values });
  }

  /**
   * Calculate MACD
   * @param {number[]} values 
   * @param {number} fastPeriod 
   * @param {number} slowPeriod 
   * @param {number} signalPeriod 
   * @returns {Array<{ MACD: number, signal: number, histogram: number }>}
   */
  static calculateMACD(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (!values || values.length < slowPeriod + signalPeriod) return [];
    return MACD.calculate({
      values,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
  }

  /**
   * Calculate ATR
   * @param {Array<{ high: number, low: number, close: number }>} candles 
   * @param {number} period 
   * @returns {number[]}
   */
  static calculateATR(candles, period = 14) {
    if (!candles || candles.length <= period) return [];
    const high = candles.map((c) => c.high);
    const low = candles.map((c) => c.low);
    const close = candles.map((c) => c.close);
    return ATR.calculate({ high, low, close, period });
  }
}
