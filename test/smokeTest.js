import { precisionManager } from '../src/binance/precision.js';
import { IndicatorCalculator } from '../src/strategy/indicators.js';
import { defaultStrategy } from '../src/strategy/defaultStrategy.js';
import { getStrategyConfig, getRiskConfig, getTokensConfig } from '../src/config/index.js';

console.log('🧪 Starting Smoke Test...');

// 1. Test Configurations
const strategyConfig = getStrategyConfig();
const riskConfig = getRiskConfig();
const tokensConfig = getTokensConfig();

if (!strategyConfig.htfTimeframe || !riskConfig.marginPerTradeUSDT || !tokensConfig.symbols) {
  throw new Error('Config validation failed.');
}
console.log('✅ Configuration test passed.');

// 2. Test Precision Manager
precisionManager.loadExchangeInfo([
  {
    symbol: 'BTCUSDT',
    filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '1', maxPrice: '1000000' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ],
  },
  {
    symbol: 'SOLUSDT',
    filters: [
      { filterType: 'LOT_SIZE', stepSize: '1', minQty: '1', maxQty: '100000' },
      { filterType: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0.01', maxPrice: '100000' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ],
  },
]);

const formattedBtcQty = precisionManager.formatQuantity('BTCUSDT', 0.12399);
if (formattedBtcQty !== '0.123') {
  throw new Error(`Expected '0.123', got '${formattedBtcQty}'`);
}

const formattedBtcPrice = precisionManager.formatPrice('BTCUSDT', 65432.189);
if (formattedBtcPrice !== '65432.20') {
  throw new Error(`Expected '65432.20', got '${formattedBtcPrice}'`);
}

const formattedSolQty = precisionManager.formatQuantity('SOLUSDT', 4.95);
if (formattedSolQty !== '4') {
  throw new Error(`Expected '4', got '${formattedSolQty}'`);
}
console.log('✅ Precision Manager tests passed.');

// 3. Test Indicators & Strategy calculation with mock candle data
const mockCloses = [];
let basePrice = 100;
for (let i = 0; i < 250; i++) {
  basePrice += (Math.random() - 0.48); // Slight upward trend
  mockCloses.push(basePrice);
}

const ema = IndicatorCalculator.calculateEMA(mockCloses, 50);
const rsi = IndicatorCalculator.calculateRSI(mockCloses, 14);
const macd = IndicatorCalculator.calculateMACD(mockCloses);

if (ema.length === 0 || rsi.length === 0 || macd.length === 0) {
  throw new Error('Indicator calculation failed.');
}
console.log(`✅ Indicators test passed: EMA len=${ema.length}, RSI len=${rsi.length}, MACD len=${macd.length}`);

// Test Strategy evaluation
const mockHtfCandles = mockCloses.map((c, i) => ({
  openTime: i * 3600000,
  open: c - 0.5,
  high: c + 1,
  low: c - 1,
  close: c,
  volume: 1000,
}));

const mockLtfCandles = mockCloses.slice(-100).map((c, i) => ({
  openTime: i * 900000,
  open: c - 0.2,
  high: c + 0.5,
  low: c - 0.5,
  close: c,
  volume: 250,
}));

const bias = defaultStrategy.evaluateHtfBias(mockHtfCandles);
console.log(`✅ HTF Bias determined: ${bias}`);

const signal = defaultStrategy.analyze('BTCUSDT', mockHtfCandles, mockLtfCandles);
const report = defaultStrategy.getAnalysisReport('BTCUSDT', mockHtfCandles, mockLtfCandles);
console.log(`✅ Strategy analyze completed (Result: ${signal ? signal.signal : 'No signal'})`);
console.log(`✅ Strategy screening report verified: [${report.status}] ${report.summary}`);

if (!report.htfBias || report.rsi === undefined || report.macdHist === undefined) {
  throw new Error('Screening report missing structured indicators (htfBias, rsi, macdHist).');
}

// 4. Test Screening Summary & Telegram Notification Formatter
const { tradingEngine } = await import('../src/engine.js');
const { notifier } = await import('../src/telegram/notifier.js');

const mockReports = [
  { symbol: 'BTCUSDT', report, price: mockCloses[mockCloses.length - 1] },
  {
    symbol: 'ETHUSDT',
    price: 2500,
    report: {
      symbol: 'ETHUSDT',
      status: 'SIGNAL_FOUND',
      htfBias: 'LONG',
      rsi: 52.3,
      macdHist: 0.125,
      signal: {
        signal: 'LONG',
        entryPrice: 2500,
        stopLossPrice: 2450,
        takeProfitPrice: 2600,
        indicators: { htfBias: 'LONG', rsi: 52.3, macdHist: 0.125 },
        reason: 'Mock signal test',
      },
      summary: 'Mock signal valid',
    },
  },
];

const summary = tradingEngine.buildScreeningSummary(mockReports, Date.now());
if (summary.totalScanned !== 2 || summary.signals.length < 1) {
  throw new Error(`Summary build failed: scanned=${summary.totalScanned}, signals=${summary.signals.length}`);
}

const formattedMessage = notifier.formatScreeningSummary(summary);
if (!formattedMessage.includes('HASIL SCREENING PASAR') || !formattedMessage.includes('ETHUSDT')) {
  throw new Error('Telegram screening notification message formatting failed.');
}
console.log('✅ Screening Digest Summary and Telegram formatting passed.');

// 5. Test PositionManager Balance parser & calculations
const { positionManager } = await import('../src/execution/positionManager.js');
const { binanceClient } = await import('../src/binance/client.js');

const origGetBalance = binanceClient.getBalance;
binanceClient.getBalance = async () => [
  { asset: 'USDT', balance: '1500.50', availableBalance: '1200.00', crossUnPnl: '25.50' },
  { asset: 'BNB', balance: '0.50', availableBalance: '0.50' },
];

const bal = await positionManager.getBalance();
if (bal.walletBalance !== 1500.5 || bal.availableBalance !== 1200.0 || Math.abs(bal.usedMargin - 300.5) > 0.001) {
  throw new Error(`Balance calculation failed: ${JSON.stringify(bal)}`);
}
// 6. Test BinanceClient ban interceptor
const origBanned = binanceClient.bannedUntil;
binanceClient.bannedUntil = Date.now() + 5000;
let caughtBan = false;
try {
  await binanceClient.request('GET', '/fapi/v1/time');
} catch (err) {
  if (err.message.includes('IP ban active')) {
    caughtBan = true;
  }
}
binanceClient.bannedUntil = origBanned;
if (!caughtBan) {
  throw new Error('Ban interceptor failed to block request.');
}
console.log('✅ BinanceClient ban interceptor test passed.');

// 7. Test PositionManager WebSocket live cache update
positionManager.handleAccountUpdate({
  P: [
    { s: 'BTCUSDT', pa: '0.050', ep: '60000', up: '15.0', iw: '0', ps: 'BOTH' },
  ],
  B: [
    { a: 'USDT', wb: '2000.0', cw: '1800.0' },
  ],
});
const wsPositions = await positionManager.getOpenPositions();
if (wsPositions.length !== 1 || wsPositions[0].symbol !== 'BTCUSDT') {
  throw new Error(`WebSocket position cache failed: ${JSON.stringify(wsPositions)}`);
}
const wsBalance = await positionManager.getBalance();
if (wsBalance.walletBalance !== 2000 || wsBalance.availableBalance !== 1800) {
  throw new Error(`WebSocket balance cache failed: ${JSON.stringify(wsBalance)}`);
}
console.log('✅ PositionManager WebSocket live cache update passed.');

console.log('🎉 All Smoke Tests Passed Successfully!');
