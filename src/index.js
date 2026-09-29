import { ENV } from './config/index.js';
import { telegramBotHandler } from './telegram/bot.js';
import { tradingEngine } from './engine.js';
import { logger } from './utils/logger.js';

async function main() {
  console.log('====================================================');
  console.log('   BINANCE USDS-M FUTURES TRADING BOT (Node.js)     ');
  console.log(`   Mode: ${ENV.MODE.toUpperCase()}                  `);
  console.log('====================================================');

  // Check required credentials
  const missingConfigs = [];
  if (!ENV.BINANCE_API_KEY) missingConfigs.push('BINANCE_API_KEY');
  if (!ENV.BINANCE_API_SECRET) missingConfigs.push('BINANCE_API_SECRET');
  if (!ENV.TELEGRAM_BOT_TOKEN) missingConfigs.push('TELEGRAM_BOT_TOKEN');
  if (!ENV.TELEGRAM_OWNER_CHAT_ID) missingConfigs.push('TELEGRAM_OWNER_CHAT_ID');

  if (missingConfigs.length > 0) {
    logger.warn('Main', `Konfigurasi environment belum lengkap: ${missingConfigs.join(', ')}.`);
    logger.warn('Main', 'Harap salin .env.example menjadi .env (atau .env.dryrun) dan isi credentials.');
  }

  // 1. Initialize Telegram bot
  telegramBotHandler.setHeartbeatChangeHandler(() => {
    tradingEngine.scheduleHeartbeat();
  });
  telegramBotHandler.setScreeningHandler(() => {
    return tradingEngine.runManualScreening();
  });
  telegramBotHandler.init();

  // 2. Start Trading Engine if API key is present
  if (ENV.BINANCE_API_KEY && ENV.BINANCE_API_SECRET) {
    try {
      await tradingEngine.start();
    } catch (err) {
      logger.error('Main', `Failed to start Trading Engine: ${err.message}`);
      process.exit(1);
    }
  } else {
    logger.warn('Main', 'Bot berjalan dalam mode standby. Harap isi file .env untuk memulai trading engine.');
  }

  // Process termination signals
  const shutdown = async (signal) => {
    logger.info('Main', `Received ${signal}. Shutting down gracefully...`);
    try {
      await tradingEngine.stop();
    } catch (e) {
      // Ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Process', 'Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Process', 'Uncaught Exception thrown:', err);
  });
}

main().catch((err) => {
  logger.error('Main', 'Fatal startup failure:', err);
  process.exit(1);
});
