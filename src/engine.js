import { binanceClient } from './binance/client.js';
import { precisionManager } from './binance/precision.js';
import { klineStream } from './binance/klineStream.js';
import { userDataStream } from './binance/userDataStream.js';
import { defaultStrategy } from './strategy/defaultStrategy.js';
import { positionManager } from './execution/positionManager.js';
import { orderManager } from './execution/orderManager.js';
import { ocoManager } from './execution/ocoManager.js';
import { notifier } from './telegram/notifier.js';
import { logger } from './utils/logger.js';
import {
  ENV,
  getStrategyConfig,
  getRiskConfig,
  getTokensConfig,
  getOperationalState,
  updateOperationalState,
} from './config/index.js';

export class TradingEngine {
  constructor() {
    // symbol -> { '15m': Array<Candle>, '1h': Array<Candle> }
    this.candleHistory = new Map();
    this.heartbeatTimer = null;
    this.isProcessingCandle = false;
    this.screeningBatch = null;
    this.latestScreeningSummary = null;
    this.isCandlesPrimed = false;
    this.isPrimingCandles = false;
  }

  async start() {
    logger.info('TradingEngine', `Starting Trading Engine in ${ENV.MODE.toUpperCase()} mode...`);

    // 1. Sync time & load exchange info
    await binanceClient.syncTime();
    logger.info('TradingEngine', 'Loading Binance exchange information...');
    const exchangeInfo = await binanceClient.getExchangeInfo();
    precisionManager.loadExchangeInfo(exchangeInfo.symbols);
    logger.info('TradingEngine', `Loaded precision filters for ${exchangeInfo.symbols.length} symbols.`);

    // 2. Initial state reconciliation
    try {
      logger.info('TradingEngine', 'Reconciling active positions and open orders...');
      await ocoManager.reconcile();
    } catch (recErr) {
      logger.warn('TradingEngine', `Initial reconciliation warning: ${recErr.message}`);
    }

    // 3. Pre-load historical candles for active tokens
    await this.primeCandleHistory();

    // 4. Connect streams & event bindings
    this.bindEvents();

    logger.info('TradingEngine', 'Starting User Data Stream...');
    await userDataStream.start();

    const tokensConfig = getTokensConfig();
    const activeSymbols = tokensConfig.symbols.slice(0, tokensConfig.maxTokens);
    const strategyConfig = getStrategyConfig();

    logger.info('TradingEngine', `Starting Kline Stream for ${activeSymbols.length} symbols...`);
    klineStream.start(activeSymbols, [strategyConfig.ltfTimeframe, strategyConfig.htfTimeframe]);

    // 5. Start heartbeat loop
    this.scheduleHeartbeat();

    // 6. Notify startup
    const modeName = ENV.MODE === 'production' ? 'Production (Mainnet)' : 'Dry Run (Testnet)';
    await notifier.notifyBotStatus('STARTED', `Mode: <b>${modeName}</b>\nTokens: <b>${activeSymbols.length} pairs</b>`);
    logger.info('TradingEngine', 'Trading Engine is fully operational.');
  }

  async primeCandleHistory() {
    if (this.isPrimingCandles) return;
    if (binanceClient.bannedUntil && Date.now() < binanceClient.bannedUntil) {
      logger.warn('TradingEngine', 'Candle priming skipped: Binance client is currently in rate-limit/ban cooldown.');
      return;
    }

    this.isPrimingCandles = true;
    const tokensConfig = getTokensConfig();
    const strategyConfig = getStrategyConfig();
    const activeSymbols = tokensConfig.symbols.slice(0, tokensConfig.maxTokens);

    logger.info('TradingEngine', `Fetching initial candles for ${activeSymbols.length} symbols (throttled)...`);
    let successCount = 0;

    for (const symbol of activeSymbols) {
      this.candleHistory.set(symbol, {
        [strategyConfig.ltfTimeframe]: [],
        [strategyConfig.htfTimeframe]: [],
      });

      try {
        // Fetch HTF candles
        const htfKlines = await binanceClient.getKlines(symbol, strategyConfig.htfTimeframe, 220);
        const formattedHtf = htfKlines.map((k) => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
        }));

        // Small pause between HTF and LTF requests
        await new Promise((r) => setTimeout(r, 200));

        // Fetch LTF candles
        const ltfKlines = await binanceClient.getKlines(symbol, strategyConfig.ltfTimeframe, 100);
        const formattedLtf = ltfKlines.map((k) => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
        }));

        this.candleHistory.get(symbol)[strategyConfig.htfTimeframe] = formattedHtf;
        this.candleHistory.get(symbol)[strategyConfig.ltfTimeframe] = formattedLtf;
        successCount++;
      } catch (err) {
        logger.warn('TradingEngine', `Could not fetch initial candles for ${symbol}: ${err.message}`);
        // If ban was triggered during fetching, abort loop immediately
        if (binanceClient.bannedUntil && Date.now() < binanceClient.bannedUntil) {
          logger.warn('TradingEngine', 'Aborting remaining candle priming due to active rate-limit/ban cooldown.');
          break;
        }
      }

      // Throttle between symbols to prevent rate limit spikes
      await new Promise((r) => setTimeout(r, 300));
    }

    this.isCandlesPrimed = (successCount >= activeSymbols.length);
    this.isPrimingCandles = false;
    logger.info('TradingEngine', `Primed candle history: ${successCount}/${activeSymbols.length} symbols ready.`);
  }

  bindEvents() {
    // User Data Stream events
    userDataStream.on('order_filled', async (order) => {
      await ocoManager.handleOrderFilled(order);
    });

    // OCO & Order events -> Telegram Notifier
    orderManager.on('position_opened', async (data) => {
      logger.info('TradingEngine', `Event position_opened dispatched for ${data.symbol}`);
      await notifier.notifyPositionOpened(data);
    });

    orderManager.on('fallback_to_market', async (data) => {
      logger.warn('TradingEngine', `Event fallback_to_market dispatched for ${data.symbol}`);
      await notifier.notifyFallbackToMarket(data);
    });

    ocoManager.on('position_closed', async (data) => {
      logger.info('TradingEngine', `Event position_closed dispatched for ${data.symbol} (${data.exitType})`);
      await notifier.notifyPositionClosed(data);
    });

    // Kline Stream events
    klineStream.on('candle', async (candle) => {
      await this.handleCandle(candle);
    });

    klineStream.on('prolonged_disconnect', async () => {
      logger.error('TradingEngine', 'Kline WebSocket prolonged disconnect (> 2m). Sending Telegram alert...');
      await notifier.send('⚠️ <b>Peringatan:</b> Data feed WebSocket Kline terputus lebih dari 2 menit. Bot sedang mencoba reconnect otomatis...');
    });

    klineStream.on('reconnected_after_disconnect', async () => {
      logger.info('TradingEngine', 'Kline WebSocket successfully reconnected after disconnect.');
      await notifier.send('✅ <b>Info:</b> Data feed WebSocket Kline berhasil terhubung kembali.');
    });

    // User Data Stream disconnect events
    userDataStream.on('prolonged_disconnect', async () => {
      logger.error('TradingEngine', 'User Data Stream prolonged disconnect (> 2m). Sending Telegram alert...');
      await notifier.send('⚠️ <b>Peringatan:</b> User Data Stream WebSocket terputus lebih dari 2 menit. Bot sedang mencoba reconnect otomatis...');
    });

    userDataStream.on('reconnected_after_disconnect', async () => {
      logger.info('TradingEngine', 'User Data Stream successfully reconnected after disconnect.');
      await notifier.send('✅ <b>Info:</b> User Data Stream WebSocket berhasil terhubung kembali.');
    });
  }

  async handleCandle(candle) {
    if (!this.isCandlesPrimed && (!binanceClient.bannedUntil || Date.now() >= binanceClient.bannedUntil)) {
      this.primeCandleHistory().catch(() => {});
    }

    const { symbol, interval, closeTime } = candle;
    const history = this.candleHistory.get(symbol);
    if (!history || !history[interval]) return;

    // Update in-memory candle series
    const series = history[interval];
    const existingIdx = series.findIndex((c) => c.openTime === candle.openTime);
    if (existingIdx !== -1) {
      series[existingIdx] = candle;
    } else {
      series.push(candle);
      if (series.length > 300) {
        series.shift();
      }
    }

    const strategyConfig = getStrategyConfig();
    const state = getOperationalState();

    // 1. Jika candle yang close adalah HTF (Trend Filter):
    if (interval === strategyConfig.htfTimeframe) {
      const htfBias = defaultStrategy.evaluateHtfBias(series);
      const pendingSignals = { ...(state.pendingSignals || {}) };

      logger.info('TradingEngine', `HTF [${symbol}]: ${strategyConfig.htfTimeframe} closed @ $${candle.close}. Bias: ${htfBias}`);

      // Kalau HTF berubah arah, reset sinyal pending confirmation untuk token ini (PRD Bagian 3)
      if (pendingSignals[symbol] && pendingSignals[symbol].htfBias !== htfBias) {
        logger.warn('TradingEngine', `HTF bias for ${symbol} changed to ${htfBias}. Resetting pending confirmation.`);
      }

      pendingSignals[symbol] = {
        htfBias,
        candleCloseTime: closeTime,
        updatedAt: Date.now(),
      };
      updateOperationalState({ pendingSignals });
      return;
    }

    // 2. Jika candle yang close adalah LTF (Entry Trigger):
    if (interval !== strategyConfig.ltfTimeframe) {
      return;
    }

    const htfCandles = history[strategyConfig.htfTimeframe];
    const ltfCandles = history[strategyConfig.ltfTimeframe];

    // Analisa sinyal strategi & tampilkan screening diagnosis
    const report = defaultStrategy.getAnalysisReport(symbol, htfCandles, ltfCandles);
    logger.info('Screening', `🔍 [${symbol}] ${strategyConfig.ltfTimeframe} close | ${report.summary}`);

    // Rekam hasil screening ke batch digest 15m untuk notifikasi Telegram
    this.recordScreeningResult(symbol, report, candle.close, closeTime);

    // Jika tidak ada sinyal entry pada token ini, selesai (tanpa query API posisi)
    const signal = report.signal;
    if (!signal) {
      return;
    }

    // Cek apakah strategy engine sedang aktif untuk eksekusi order
    if (!state.isStrategyRunning) {
      logger.info('TradingEngine', `[${symbol}] Valid signal detected but Strategy PAUSED (/stop). Skipping order execution.`);
      return;
    }

    // Hindari double order pada candle yang sama
    if (state.lastProcessedCandles[symbol] === closeTime) {
      return;
    }

    const riskConfig = getRiskConfig();
    if (riskConfig.excludedTokens?.includes(symbol)) {
      logger.info('TradingEngine', `[${symbol}] Token is in excludedTokens list. Skipping order execution.`);
      return;
    }

    // Cek batas maksimum posisi terbuka (hanya dijalankan jika ada sinyal valid)
    const openPositions = await positionManager.getOpenPositions();
    if (openPositions.length >= (riskConfig.maxOpenPositions || 5)) {
      logger.info('TradingEngine', `[${symbol}] Max open positions reached (${openPositions.length}/${riskConfig.maxOpenPositions || 5}). Skipping order execution.`);
      return;
    }

    // Pastikan tidak ada 2 posisi pada token yang sama
    const alreadyOpen = openPositions.some((p) => p.symbol.toUpperCase() === symbol);
    if (alreadyOpen) {
      logger.info('TradingEngine', `[${symbol}] Position already open for this symbol. Skipping order execution.`);
      return;
    }

    logger.info('TradingEngine', `🎯 VALID SIGNAL DETECTED [${symbol}]: ${signal.signal} -> ${signal.reason}`);

    // Tandai candle sudah diproses & update state pending confirmation
    const updatedLastCandles = { ...state.lastProcessedCandles, [symbol]: closeTime };
    const pendingSignals = { ...(state.pendingSignals || {}) };
    pendingSignals[symbol] = {
      htfBias: signal.indicators.htfBias,
      signal: signal.signal,
      status: 'EXECUTED',
      executedAt: Date.now(),
    };
    updateOperationalState({ lastProcessedCandles: updatedLastCandles, pendingSignals });

    // Eksekusi order
    try {
      await orderManager.executeSignal(signal);
    } catch (err) {
      logger.error('TradingEngine', `Execution failed for ${symbol}: ${err.message}`);
      await notifier.notifyExecutionError(symbol, 'ENTRY', err.message);
    }
  }

  recordScreeningResult(symbol, report, price, closeTime) {
    if (!this.screeningBatch || this.screeningBatch.closeTime !== closeTime) {
      if (this.screeningBatch?.timer) {
        clearTimeout(this.screeningBatch.timer);
        this.dispatchScreeningSummary();
      }
      this.screeningBatch = {
        closeTime,
        reports: [],
        timer: null,
      };
    }

    const existingIdx = this.screeningBatch.reports.findIndex((r) => r.symbol === symbol);
    if (existingIdx !== -1) {
      this.screeningBatch.reports[existingIdx] = { symbol, report, price };
    } else {
      this.screeningBatch.reports.push({ symbol, report, price });
    }

    if (this.screeningBatch.timer) {
      clearTimeout(this.screeningBatch.timer);
    }

    // Debounce 3500ms agar semua token pada 15m candle close terkumpul dalam 1 digest
    this.screeningBatch.timer = setTimeout(() => {
      this.dispatchScreeningSummary();
    }, 3500);
  }

  async dispatchScreeningSummary() {
    if (!this.screeningBatch || this.screeningBatch.reports.length === 0) return;
    const batch = { ...this.screeningBatch };
    this.screeningBatch = null;

    const summary = this.buildScreeningSummary(batch.reports, batch.closeTime || Date.now());
    try {
      const openPositions = await positionManager.getOpenPositions();
      const risk = getRiskConfig();
      summary.openPositionsCount = openPositions.length;
      summary.maxOpenPositions = risk.maxOpenPositions || 5;
    } catch (e) {}
    this.latestScreeningSummary = summary;

    const state = getOperationalState();
    const notifyMode = state.screeningNotifyMode || 'all';

    logger.info('Screening', `15m Screening cycle complete: ${summary.totalScanned} scanned, ${summary.signals.length} valid signals found (Notify mode: ${notifyMode}).`);

    if (notifyMode === 'off') {
      return;
    }
    if (notifyMode === 'signals_only' && summary.signals.length === 0) {
      return;
    }

    try {
      await notifier.notifyScreeningSummary(summary);
    } catch (err) {
      logger.error('Screening', `Failed to send screening digest to Telegram: ${err.message}`);
    }
  }

  buildScreeningSummary(reports, timestamp = Date.now()) {
    const signals = [];
    const watchlist = [];
    const biasSummary = {
      bullish: [],
      bearish: [],
      neutral: [],
    };

    for (const item of reports) {
      const { symbol, report, price } = item;
      const htfBias = report.htfBias || 'NEUTRAL';

      if (htfBias === 'LONG') {
        biasSummary.bullish.push(symbol);
      } else if (htfBias === 'SHORT') {
        biasSummary.bearish.push(symbol);
      } else {
        biasSummary.neutral.push(symbol);
      }

      if (report.signal) {
        signals.push({
          symbol,
          signal: report.signal.signal,
          entryPrice: report.signal.entryPrice || price,
          stopLossPrice: report.signal.stopLossPrice,
          takeProfitPrice: report.signal.takeProfitPrice,
          indicators: report.signal.indicators,
          reason: report.signal.reason,
        });
      } else if (report.status === 'WAITING') {
        watchlist.push({
          symbol,
          htfBias,
          rsi: report.rsi,
          macdHist: report.macdHist,
          waitingReason: report.waitingReason,
          price,
        });
      }
    }

    return {
      timestamp,
      totalScanned: reports.length,
      signals,
      watchlist,
      biasSummary,
    };
  }

  async runManualScreening() {
    const tokensConfig = getTokensConfig();
    const activeSymbols = tokensConfig.symbols.slice(0, tokensConfig.maxTokens);
    const strategyConfig = getStrategyConfig();
    const reports = [];

    for (const symbol of activeSymbols) {
      const history = this.candleHistory.get(symbol);
      if (!history) continue;
      const htfCandles = history[strategyConfig.htfTimeframe];
      const ltfCandles = history[strategyConfig.ltfTimeframe];
      if (!htfCandles || !ltfCandles || ltfCandles.length < 2) continue;

      const lastCandle = ltfCandles[ltfCandles.length - 1];
      const report = defaultStrategy.getAnalysisReport(symbol, htfCandles, ltfCandles);
      reports.push({ symbol, report, price: lastCandle.close });
    }

    const summary = this.buildScreeningSummary(reports, Date.now());
    try {
      const openPositions = await positionManager.getOpenPositions();
      const risk = getRiskConfig();
      summary.openPositionsCount = openPositions.length;
      summary.maxOpenPositions = risk.maxOpenPositions || 5;
    } catch (e) {}
    this.latestScreeningSummary = summary;
    return summary;
  }

  scheduleHeartbeat() {
    clearInterval(this.heartbeatTimer);

    const tick = async () => {
      try {
        const state = getOperationalState();
        const intervalMinutes = state.heartbeatIntervalMinutes ?? 10;

        if (intervalMinutes > 0) {
          logger.info('TradingEngine', 'Running periodic Heartbeat & safety reconciliation...');
          // Retry candle priming if incomplete and not in ban cooldown
          if (!this.isCandlesPrimed && (!binanceClient.bannedUntil || Date.now() >= binanceClient.bannedUntil)) {
            logger.info('TradingEngine', 'Candle history incomplete. Retrying candle priming in background...');
            await this.primeCandleHistory();
          }

          // Cross-check & reconcile orders & positions
          await ocoManager.reconcile();

          const positions = await positionManager.getOpenPositions();
          // Enrich each position with funding rate (PRD Section 13)
          for (const pos of positions) {
            pos.fundingRate = await positionManager.getFundingRate(pos.symbol);
          }
          const balance = await positionManager.getBalance().catch(() => null);
          await notifier.notifyHeartbeat(positions, ENV.MODE, state.isStrategyRunning, balance);
          logger.info('TradingEngine', `Heartbeat completed. Monitored positions: ${positions.length}`);
        }
      } catch (err) {
        logger.error('TradingEngine', `Heartbeat error: ${err.message}`);
      }
    };

    const state = getOperationalState();
    const intervalMs = Math.max(1, state.heartbeatIntervalMinutes || 10) * 60 * 1000;
    this.heartbeatTimer = setInterval(tick, intervalMs);
    logger.info('TradingEngine', `Heartbeat scheduled every ${state.heartbeatIntervalMinutes || 10} minutes.`);
  }

  async stop() {
    logger.info('TradingEngine', 'Stopping Trading Engine...');
    clearInterval(this.heartbeatTimer);
    if (this.screeningBatch?.timer) {
      clearTimeout(this.screeningBatch.timer);
    }
    klineStream.stop();
    userDataStream.stop();
    await notifier.notifyBotStatus('STOPPED', 'Bot dihentikan oleh sistem/proses.');
    logger.info('TradingEngine', 'Trading Engine stopped.');
  }
}

export const tradingEngine = new TradingEngine();
