import { IndicatorCalculator } from './indicators.js';
import { getStrategyConfig } from '../config/index.js';

export class DefaultStrategy {
  constructor() {
    this.name = 'HTF_Trend_LTF_Momentum_ATR';
  }

  /**
   * Determine Trend Bias on HTF candles
   * @param {Array} htfCandles - Sorted oldest to newest
   * @returns {'LONG' | 'SHORT' | 'NEUTRAL'}
   */
  evaluateHtfBias(htfCandles) {
    const config = getStrategyConfig();
    const closePrices = htfCandles.map((c) => c.close);

    const emaFast = IndicatorCalculator.calculateEMA(closePrices, config.emaFastPeriod);
    const emaSlow = IndicatorCalculator.calculateEMA(closePrices, config.emaSlowPeriod);

    if (emaFast.length === 0 || emaSlow.length === 0) {
      return 'NEUTRAL';
    }

    const latestFast = emaFast[emaFast.length - 1];
    const latestSlow = emaSlow[emaSlow.length - 1];

    if (latestFast > latestSlow) return 'LONG';
    if (latestFast < latestSlow) return 'SHORT';
    return 'NEUTRAL';
  }

  /**
   * Comprehensive analysis report for screening with diagnostic metrics
   * @param {string} symbol 
   * @param {Array} htfCandles 
   * @param {Array} ltfCandles 
   */
  getAnalysisReport(symbol, htfCandles, ltfCandles) {
    if (!htfCandles || htfCandles.length < 200 || !ltfCandles || ltfCandles.length < 50) {
      return {
        symbol,
        signal: null,
        status: 'INSUFFICIENT_DATA',
        summary: `Insufficient candle data (HTF: ${htfCandles?.length || 0}/200, LTF: ${ltfCandles?.length || 0}/50)`,
      };
    }

    const config = getStrategyConfig();
    const htfBias = this.evaluateHtfBias(htfCandles);

    const ltfCloses = ltfCandles.map((c) => c.close);
    const rsiValues = IndicatorCalculator.calculateRSI(ltfCloses, config.rsiPeriod);
    const macdValues = IndicatorCalculator.calculateMACD(
      ltfCloses,
      config.macdFastPeriod,
      config.macdSlowPeriod,
      config.macdSignalPeriod
    );
    const atrValues = IndicatorCalculator.calculateATR(ltfCandles, config.atrPeriod);

    if (rsiValues.length < 2 || macdValues.length < 2 || atrValues.length < 1) {
      return {
        symbol,
        signal: null,
        status: 'CALC_ERROR',
        summary: 'Error calculating technical indicators',
      };
    }

    const latestRSI = rsiValues[rsiValues.length - 1];
    const prevRSI = rsiValues[rsiValues.length - 2];

    const latestMACD = macdValues[macdValues.length - 1];
    const prevMACD = macdValues[macdValues.length - 2];

    const latestATR = atrValues[atrValues.length - 1];
    const latestCandle = ltfCandles[ltfCandles.length - 1];
    const entryPrice = latestCandle.close;

    if (htfBias === 'NEUTRAL') {
      return {
        symbol,
        signal: null,
        status: 'NEUTRAL',
        htfBias,
        rsi: latestRSI,
        macdHist: latestMACD.histogram,
        waitingReason: 'HTF Trend not clear (NEUTRAL)',
        summary: `Price: $${entryPrice} | HTF Bias: NEUTRAL | RSI: ${latestRSI.toFixed(1)} | MACD Hist: ${latestMACD.histogram.toFixed(4)} -> Trend not clear`,
      };
    }

    // Check Long condition:
    // 1. HTF Bias is LONG (EMA 50 > EMA 200 on 1H)
    // 2. MACD Histogram turned positive or crossed up (prev <= 0 and curr > 0)
    // 3. RSI is in bullish momentum territory (> 45 and not overbought < config.rsiOverbought)
    const isMacdBullishCross = prevMACD.histogram <= 0 && latestMACD.histogram > 0;
    const isRsiBullish = latestRSI > 45 && latestRSI < config.rsiOverbought;

    if (htfBias === 'LONG') {
      if (isMacdBullishCross && isRsiBullish) {
        const slDistance = latestATR * (config.atrMultiplierSL || 2.0);
        const stopLossPrice = entryPrice - slDistance;
        const takeProfitPrice = entryPrice + slDistance * (config.tpSlRatio || 2.0);

        const rawCallbackRate = ((slDistance * (config.trailingCallbackMultiplier || 1.5)) / entryPrice) * 100;
        const trailingCallbackRate = Number(Math.min(5.0, Math.max(0.1, rawCallbackRate)).toFixed(1));

        const signalObj = {
          strategy: this.name,
          symbol,
          signal: 'LONG',
          entryPrice,
          stopLossPrice,
          takeProfitPrice,
          trailingCallbackRate,
          atr: latestATR,
          indicators: {
            htfBias,
            rsi: latestRSI,
            macdHist: latestMACD.histogram,
          },
          reason: `HTF Uptrend + LTF MACD Bullish Cross (${prevMACD.histogram.toFixed(4)} -> ${latestMACD.histogram.toFixed(4)}) + RSI (${latestRSI.toFixed(1)})`,
          timestamp: Date.now(),
        };

        return {
          symbol,
          signal: signalObj,
          status: 'SIGNAL_FOUND',
          htfBias,
          rsi: latestRSI,
          macdHist: latestMACD.histogram,
          summary: `Price: $${entryPrice} | HTF: LONG | RSI: ${latestRSI.toFixed(1)} | MACD: Bullish Cross (${prevMACD.histogram.toFixed(4)} -> ${latestMACD.histogram.toFixed(4)}) -> 🎯 SIGNAL VALID`,
        };
      }

      const reasonWaiting = !isMacdBullishCross
        ? `Waiting for MACD Bullish Cross (Hist: ${latestMACD.histogram.toFixed(4)})`
        : `RSI (${latestRSI.toFixed(1)}) not in target zone (45-${config.rsiOverbought})`;

      return {
        symbol,
        signal: null,
        status: 'WAITING',
        htfBias,
        rsi: latestRSI,
        macdHist: latestMACD.histogram,
        waitingReason: reasonWaiting,
        summary: `Price: $${entryPrice} | HTF: LONG | RSI: ${latestRSI.toFixed(1)} | MACD Hist: ${latestMACD.histogram.toFixed(4)} -> ${reasonWaiting}`,
      };
    }

    // Check Short condition:
    // 1. HTF Bias is SHORT (EMA 50 < EMA 200 on 1H)
    // 2. MACD Histogram turned negative or crossed down (prev >= 0 and curr < 0)
    // 3. RSI is in bearish momentum territory (< 55 and not oversold > config.rsiOversold)
    const isMacdBearishCross = prevMACD.histogram >= 0 && latestMACD.histogram < 0;
    const isRsiBearish = latestRSI < 55 && latestRSI > config.rsiOversold;

    if (htfBias === 'SHORT') {
      if (isMacdBearishCross && isRsiBearish) {
        const slDistance = latestATR * (config.atrMultiplierSL || 2.0);
        const stopLossPrice = entryPrice + slDistance;
        const takeProfitPrice = entryPrice - slDistance * (config.tpSlRatio || 2.0);

        const rawCallbackRate = ((slDistance * (config.trailingCallbackMultiplier || 1.5)) / entryPrice) * 100;
        const trailingCallbackRate = Number(Math.min(5.0, Math.max(0.1, rawCallbackRate)).toFixed(1));

        const signalObj = {
          strategy: this.name,
          symbol,
          signal: 'SHORT',
          entryPrice,
          stopLossPrice,
          takeProfitPrice,
          trailingCallbackRate,
          atr: latestATR,
          indicators: {
            htfBias,
            rsi: latestRSI,
            macdHist: latestMACD.histogram,
          },
          reason: `HTF Downtrend + LTF MACD Bearish Cross (${prevMACD.histogram.toFixed(4)} -> ${latestMACD.histogram.toFixed(4)}) + RSI (${latestRSI.toFixed(1)})`,
          timestamp: Date.now(),
        };

        return {
          symbol,
          signal: signalObj,
          status: 'SIGNAL_FOUND',
          htfBias,
          rsi: latestRSI,
          macdHist: latestMACD.histogram,
          summary: `Price: $${entryPrice} | HTF: SHORT | RSI: ${latestRSI.toFixed(1)} | MACD: Bearish Cross (${prevMACD.histogram.toFixed(4)} -> ${latestMACD.histogram.toFixed(4)}) -> 🎯 SIGNAL VALID`,
        };
      }

      const reasonWaiting = !isMacdBearishCross
        ? `Waiting for MACD Bearish Cross (Hist: ${latestMACD.histogram.toFixed(4)})`
        : `RSI (${latestRSI.toFixed(1)}) not in target zone (${config.rsiOversold}-55)`;

      return {
        symbol,
        signal: null,
        status: 'WAITING',
        htfBias,
        rsi: latestRSI,
        macdHist: latestMACD.histogram,
        waitingReason: reasonWaiting,
        summary: `Price: $${entryPrice} | HTF: SHORT | RSI: ${latestRSI.toFixed(1)} | MACD Hist: ${latestMACD.histogram.toFixed(4)} -> ${reasonWaiting}`,
      };
    }

    return {
      symbol,
      signal: null,
      status: 'NO_SIGNAL',
      htfBias,
      rsi: latestRSI,
      macdHist: latestMACD.histogram,
      waitingReason: 'No setup found',
      summary: `Price: $${entryPrice} | HTF: ${htfBias} | RSI: ${latestRSI.toFixed(1)} | MACD Hist: ${latestMACD.histogram.toFixed(4)}`,
    };
  }

  /**
   * Analyze both HTF and LTF candles for a symbol
   * @param {string} symbol 
   * @param {Array} htfCandles 
   * @param {Array} ltfCandles 
   * @returns {Object|null} Signal object or null
   */
  analyze(symbol, htfCandles, ltfCandles) {
    const report = this.getAnalysisReport(symbol, htfCandles, ltfCandles);
    return report ? report.signal : null;
  }
}

export const defaultStrategy = new DefaultStrategy();
