import { Telegraf, Markup } from 'telegraf';
import {
  ENV,
  getOperationalState,
  updateOperationalState,
  getRiskConfig,
  updateRiskConfig,
  getTokensConfig,
  updateTokensConfig,
} from '../config/index.js';
import { positionManager } from '../execution/positionManager.js';
import { orderManager } from '../execution/orderManager.js';
import { ocoManager } from '../execution/ocoManager.js';
import { klineStream } from '../binance/klineStream.js';
import { notifier } from './notifier.js';
import { logger } from '../utils/logger.js';

export const quickMenuKeyboard = Markup.keyboard([
  ['📊 Status', '🔍 Screening'],
  ['💰 Saldo', '💓 Heartbeat'],
  ['🟢 Start Strategy', '⏸️ Stop Strategy'],
  ['❓ Help'],
]).resize();

export class TelegramBotHandler {
  constructor() {
    this.bot = null;
    this.ownerChatId = ENV.TELEGRAM_OWNER_CHAT_ID;
    this.onHeartbeatChange = null;
    this.onScreeningRequest = null;
  }

  setHeartbeatChangeHandler(fn) {
    this.onHeartbeatChange = fn;
  }

  setScreeningHandler(fn) {
    this.onScreeningRequest = fn;
  }

  async registerTelegramMenu() {
    try {
      await this.bot.telegram.setMyCommands([
        { command: 'menu', description: '📱 Tampilkan tombol menu interaktif' },
        { command: 'status', description: '📊 Cek posisi & PnL berjalan' },
        { command: 'balance', description: '💰 Cek saldo wallet & margin Binance' },
        { command: 'screening', description: '🔍 Cek hasil screening pasar saat ini' },
        { command: 'start', description: '🟢 Aktifkan strategy engine' },
        { command: 'stop', description: '⏸️ Jeda strategy engine' },
        { command: 'close', description: '🛑 Tutup posisi: /close <symbol>' },
        { command: 'setsize', description: '💰 Ubah margin trade: /setsize <usdt>' },
        { command: 'setmaxpositions', description: '🔢 Ubah max posisi: /setmaxpositions <n>' },
        { command: 'setmaxtokens', description: '🪙 Ubah max token: /setmaxtokens <n>' },
        { command: 'set_screening_notify', description: '🔔 Notifikasi screening: all/signals_only/off' },
        { command: 'set_heartbeat', description: '💓 Atur interval heartbeat: /set_heartbeat <min>' },
        { command: 'help', description: '❓ Panduan lengkap perintah' },
      ]);
      logger.info('TelegramBot', 'Registered official Telegram command menu (setMyCommands).');
    } catch (err) {
      logger.warn('TelegramBot', `Failed to register Telegram command menu: ${err.message}`);
    }
  }

  init() {
    if (!ENV.TELEGRAM_BOT_TOKEN) {
      logger.warn('TelegramBot', 'No TELEGRAM_BOT_TOKEN provided. Telegram bot will not start.');
      return;
    }

    this.bot = new Telegraf(ENV.TELEGRAM_BOT_TOKEN);
    notifier.setBot(this.bot);

    // Security Middleware: Owner Guard
    this.bot.use(async (ctx, next) => {
      const fromId = ctx.from?.id ? String(ctx.from.id) : '';
      if (this.ownerChatId && fromId !== this.ownerChatId) {
        logger.warn('TelegramBot', `Unauthorized access attempt blocked from ID: ${fromId} (@${ctx.from?.username || 'unknown'})`);
        return; // Silently ignore unauthorized messages
      }
      return next();
    });

    this.registerCommands();

    this.bot.launch().then(async () => {
      logger.info('TelegramBot', 'Telegram bot is online and listening for commands.');
      await this.registerTelegramMenu();
    }).catch((err) => {
      logger.error('TelegramBot', `Failed to launch bot: ${err.message}`);
    });

    // Graceful stop
    process.once('SIGINT', () => this.bot?.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot?.stop('SIGTERM'));
  }

  async sendStatus(ctx) {
    try {
      const state = getOperationalState();
      const risk = getRiskConfig();
      const tokens = getTokensConfig();
      const positions = await positionManager.getOpenPositions();

      const modeText = ENV.MODE === 'production' ? '🔥 Mainnet (Production)' : '🧪 Testnet (Dry Run)';
      const statusText = state.isStrategyRunning ? '🟢 Aktif Running' : '⏸️ Sedang Dijeda';

      let posText = '<i>Tidak ada posisi terbuka.</i>';
      if (positions.length > 0) {
        const formatted = [];
        for (const p of positions) {
          const dir = parseFloat(p.positionAmt) > 0 ? '🟢 LONG' : '🔴 SHORT';
          const pnl = parseFloat(p.unRealizedProfit);
          const sign = pnl >= 0 ? '+' : '';
          const funding = await positionManager.getFundingRate(p.symbol);
          const fundingSign = funding >= 0 ? '+' : '';
          formatted.push(
            `• <b>${p.symbol}</b> [${dir} ${p.leverage}x]\n  Entry: <code>$${parseFloat(p.entryPrice)}</code> | PnL: <code>${sign}$${pnl.toFixed(2)} USDT</code> | Funding: <code>${fundingSign}${funding.toFixed(4)}%</code>`
          );
        }
        posText = formatted.join('\n');
      }

      let balanceLine = '';
      try {
        const bal = await positionManager.getBalance();
        if (bal) {
          const pnlSign = bal.unrealizedPnL >= 0 ? '+' : '';
          balanceLine = `\n• <b>Saldo Wallet:</b> <code>$${bal.walletBalance.toFixed(2)} USDT</code>\n• <b>Saldo Tersedia:</b> <code>$${bal.availableBalance.toFixed(2)} USDT</code> (Floating: <code>${pnlSign}$${bal.unrealizedPnL.toFixed(2)}</code>)`;
        }
      } catch (e) {
        // Ignore balance fetch failure in general status
      }

      const reply = `
<b>📊 STATUS BOT</b>
• <b>Mode:</b> ${modeText}
• <b>Strategy Status:</b> ${statusText}${balanceLine}
• <b>Margin per Trade:</b> <code>$${risk.marginPerTradeUSDT} USDT</code>
• <b>Max Posisi Bersamaan:</b> <code>${risk.maxOpenPositions}</code>
• <b>Jumlah Token Scan:</b> <code>${tokens.symbols.slice(0, tokens.maxTokens).length} tokens</code>
• <b>Interval Heartbeat:</b> <code>${state.heartbeatIntervalMinutes} menit</code>

<b>Posisi Terbuka (${positions.length}/${risk.maxOpenPositions}):</b>
${posText}
`.trim();

      await ctx.replyWithHTML(reply, quickMenuKeyboard);
    } catch (err) {
      logger.error('TelegramBot', `Failed to get status: ${err.message}`);
      await ctx.replyWithHTML(`❌ Gagal mengambil status: <code>${err.message}</code>`, quickMenuKeyboard);
    }
  }

  async sendHelp(ctx) {
    const helpText = `
<b>🤖 Panduan Perintah Binance Futures Trading Bot</b>

<b>Kontrol Cepat & Analisa:</b>
• <code>/menu</code> - Buka keyboard tombol interaktif
• <code>/status</code> - Cek status bot, saldo margin & posisi terbuka
• <code>/balance</code> (atau <code>/saldo</code>) - Cek saldo wallet & margin akun Binance
• <code>/screening</code> - Cek hasil pemindaian pasar 15M/1H terkini
• <code>/start</code> - Aktifkan strategy engine (buka posisi baru jika ada sinyal)
• <code>/stop</code> - Jeda strategy engine (tidak membuka posisi baru)

<b>Pengaturan Notifikasi & Risiko:</b>
• <code>/set_screening_notify &lt;all|signals_only|off&gt;</code> - Mode notif screening berkala
• <code>/setsize &lt;usdt&gt;</code> - Ubah margin size per trade (contoh: <code>/setsize 100</code>)
• <code>/setmaxpositions &lt;n&gt;</code> - Ubah max posisi terbuka bersamaan (contoh: <code>/setmaxpositions 5</code>)
• <code>/setmaxtokens &lt;n&gt;</code> - Ubah jumlah token yang dipindai (contoh: <code>/setmaxtokens 20</code>)
• <code>/set_heartbeat &lt;menit&gt;</code> - Atur interval heartbeat notifikasi (0 untuk off)

<b>Tindakan Darurat:</b>
• <code>/close &lt;symbol&gt;</code> - Tutup posisi tertentu langsung dengan Market Order (contoh: <code>/close BTCUSDT</code>)
`.trim();
    await ctx.replyWithHTML(helpText, quickMenuKeyboard);
  }

  async sendBalance(ctx) {
    try {
      await ctx.replyWithHTML('⏳ <i>Mengambil data saldo akun Binance Futures...</i>');
      const balance = await positionManager.getBalance();
      if (!balance) {
        return ctx.replyWithHTML('❌ Tidak dapat mengambil data saldo dari Binance.', quickMenuKeyboard);
      }

      const modeText = ENV.MODE === 'production' ? '🔥 Mainnet (Production)' : '🧪 Testnet (Dry Run)';
      const pnlSign = balance.unrealizedPnL >= 0 ? '+' : '';
      const risk = getRiskConfig();

      let otherLines = '';
      if (balance.otherAssets.length > 0) {
        otherLines = '\n\n<b>Aset Lain:</b>\n' + balance.otherAssets
          .map((a) => `• <b>${a.asset}:</b> <code>${parseFloat(a.balance).toFixed(4)}</code> (Tersedia: <code>${parseFloat(a.availableBalance).toFixed(4)}</code>)`)
          .join('\n');
      }

      const message = `
💰 <b>SALDO AKUN BINANCE FUTURES</b>
• <b>Mode:</b> ${modeText}
• <b>Total Wallet Balance:</b> <code>$${balance.walletBalance.toFixed(2)} USDT</code>
• <b>Saldo Tersedia (Available):</b> <code>$${balance.availableBalance.toFixed(2)} USDT</code>
• <b>Margin Digunakan:</b> <code>$${balance.usedMargin.toFixed(2)} USDT</code>
• <b>Floating PnL (Unrealized):</b> <code>${pnlSign}$${balance.unrealizedPnL.toFixed(2)} USDT</code>${otherLines}

💡 <i>Ukuran Margin per trade saat ini: <b>$${risk.marginPerTradeUSDT} USDT</b> (/setsize)</i>
`.trim();

      await ctx.replyWithHTML(message, quickMenuKeyboard);
    } catch (err) {
      logger.error('TelegramBot', `Failed to get balance: ${err.message}`);
      await ctx.replyWithHTML(`❌ Gagal mengambil saldo: <code>${err.message}</code>`, quickMenuKeyboard);
    }
  }

  async sendScreening(ctx) {
    try {
      if (!this.onScreeningRequest) {
        return ctx.replyWithHTML('⚠️ Trading Engine belum aktif atau screening handler belum terpasang.', quickMenuKeyboard);
      }
      await ctx.replyWithHTML('⏳ <i>Melakukan pemindaian pasar terkini (15M / 1H)...</i>');
      const summary = this.onScreeningRequest();
      if (!summary || summary.totalScanned === 0) {
        return ctx.replyWithHTML('⚠️ Data candle belum siap untuk screening. Harap tunggu beberapa saat agar candle terisi.', quickMenuKeyboard);
      }
      const message = notifier.formatScreeningSummary(summary);
      await ctx.replyWithHTML(message, quickMenuKeyboard);
    } catch (err) {
      logger.error('TelegramBot', `Failed to execute manual screening: ${err.message}`);
      await ctx.replyWithHTML(`❌ Gagal screening: <code>${err.message}</code>`, quickMenuKeyboard);
    }
  }

  registerCommands() {
    // /menu - Show interactive quick action keyboard
    this.bot.command('menu', async (ctx) => {
      logger.info('TelegramBot', `Command /menu executed by ${ctx.from.id}`);
      await ctx.replyWithHTML('📱 <b>Menu Kontrol Bot</b>\nPilih tombol di bawah untuk akses cepat:', quickMenuKeyboard);
    });

    // /start - Start strategy engine signal generation
    this.bot.command('start', async (ctx) => {
      logger.info('TelegramBot', `Command /start executed by ${ctx.from.id}`);
      updateOperationalState({ isStrategyRunning: true });
      await ctx.replyWithHTML('🟢 <b>Strategy Engine DIAKTIFKAN.</b>\nBot akan memproses sinyal dan mengeksekusi order.', quickMenuKeyboard);
    });

    // /stop - Pause strategy engine
    this.bot.command('stop', async (ctx) => {
      logger.info('TelegramBot', `Command /stop executed by ${ctx.from.id}`);
      updateOperationalState({ isStrategyRunning: false });
      await ctx.replyWithHTML('⏸️ <b>Strategy Engine DIJEDA.</b>\nBot tidak akan membuka posisi baru (posisi yang ada tetap diproteksi).', quickMenuKeyboard);
    });

    // /status - Check current status
    this.bot.command('status', async (ctx) => {
      logger.info('TelegramBot', `Command /status executed by ${ctx.from.id}`);
      await this.sendStatus(ctx);
    });

    // /balance & /saldo - Check Futures wallet and margin balance
    this.bot.command(['balance', 'saldo'], async (ctx) => {
      logger.info('TelegramBot', `Command /balance executed by ${ctx.from.id}`);
      await this.sendBalance(ctx);
    });

    // /screening - Run manual screening
    this.bot.command('screening', async (ctx) => {
      logger.info('TelegramBot', `Command /screening executed by ${ctx.from.id}`);
      await this.sendScreening(ctx);
    });

    // /set_screening_notify <all|signals_only|off>
    this.bot.command('set_screening_notify', async (ctx) => {
      const args = ctx.message.text.trim().split(/\s+/);
      const rawMode = args[1]?.toLowerCase();

      let mode = rawMode;
      if (rawMode === 'on') mode = 'all';
      if (rawMode === 'signals') mode = 'signals_only';

      if (!['all', 'signals_only', 'off'].includes(mode)) {
        const state = getOperationalState();
        const current = state.screeningNotifyMode || 'all';
        return ctx.replyWithHTML(`
ℹ️ <b>Pengaturan Notifikasi Screening</b>
Mode notifikasi otomatis saat ini: <b>${current.toUpperCase()}</b>

<b>Pilihan mode:</b>
• <code>/set_screening_notify all</code> - Kirim notifikasi hasil screening setiap candle 15m close
• <code>/set_screening_notify signals_only</code> - Kirim hanya jika terdeteksi sinyal entry valid
• <code>/set_screening_notify off</code> - Matikan notifikasi otomatis (screening manual tetap bisa via tombol 🔍)
`.trim(), quickMenuKeyboard);
      }

      logger.info('TelegramBot', `Command /set_screening_notify ${mode} executed by ${ctx.from.id}`);
      updateOperationalState({ screeningNotifyMode: mode });

      const desc = mode === 'all'
        ? 'Setiap candle 15m selesai dievaluasi (semua token).'
        : mode === 'signals_only'
        ? 'Hanya ketika sinyal entry valid terdeteksi.'
        : 'Notifikasi otomatis dimatikan.';

      await ctx.replyWithHTML(`✅ <b>Notifikasi Screening diubah ke:</b> <code>${mode.toUpperCase()}</code>\n${desc}`, quickMenuKeyboard);
    });

    // /setsize <usdt> - Set margin per trade
    this.bot.command('setsize', async (ctx) => {
      const args = ctx.message.text.split(' ');
      const amount = parseFloat(args[1]);

      if (isNaN(amount) || amount <= 0) {
        return ctx.replyWithHTML('❌ Format salah. Contoh: <code>/setsize 100</code>');
      }

      logger.info('TelegramBot', `Command /setsize ${amount} executed by ${ctx.from.id}`);
      updateRiskConfig({ marginPerTradeUSDT: amount });
      await ctx.replyWithHTML(`✅ <b>Position size diubah menjadi:</b> <code>$${amount} USDT</code> per trade.`, quickMenuKeyboard);
    });

    // /setmaxpositions <n> - Set max simultaneous positions
    this.bot.command('setmaxpositions', async (ctx) => {
      const args = ctx.message.text.split(' ');
      const max = parseInt(args[1], 10);

      if (isNaN(max) || max < 1) {
        return ctx.replyWithHTML('❌ Format salah. Contoh: <code>/setmaxpositions 5</code>');
      }

      logger.info('TelegramBot', `Command /setmaxpositions ${max} executed by ${ctx.from.id}`);
      updateRiskConfig({ maxOpenPositions: max });
      await ctx.replyWithHTML(`✅ <b>Max posisi bersamaan diubah menjadi:</b> <code>${max}</code>`, quickMenuKeyboard);
    });

    // /setmaxtokens <n> - Set max scanned tokens
    this.bot.command('setmaxtokens', async (ctx) => {
      const args = ctx.message.text.split(' ');
      const max = parseInt(args[1], 10);

      if (isNaN(max) || max < 1) {
        return ctx.replyWithHTML('❌ Format salah. Contoh: <code>/setmaxtokens 20</code>');
      }

      logger.info('TelegramBot', `Command /setmaxtokens ${max} executed by ${ctx.from.id}`);
      const updated = updateTokensConfig({ maxTokens: max });
      const activeSymbols = updated.symbols.slice(0, updated.maxTokens);
      klineStream.updateSymbols(activeSymbols);
      await ctx.replyWithHTML(`✅ <b>Maksimal token yang dipindai diubah menjadi:</b> <code>${max}</code>.\nWebSocket stream diperbarui live (${activeSymbols.length} pairs).`, quickMenuKeyboard);
    });

    // /close <symbol> - Close specific position manually
    this.bot.command('close', async (ctx) => {
      const args = ctx.message.text.split(' ');
      const symbol = args[1]?.toUpperCase();

      if (!symbol) {
        return ctx.replyWithHTML('❌ Harap tentukan symbol. Contoh: <code>/close BTCUSDT</code>');
      }

      logger.info('TelegramBot', `Command /close ${symbol} requested by ${ctx.from.id}`);
      try {
        await ctx.replyWithHTML(`⏳ Menutup posisi <b>${symbol}</b> secara manual...`);
        const result = await orderManager.closePositionMarket(symbol);
        logger.info('TelegramBot', `Position ${symbol} successfully closed via command by ${ctx.from.id}`);
        await ctx.replyWithHTML(`✅ <b>Posisi ${symbol} berhasil ditutup!</b>\nQty: <code>${result.quantity}</code> | Harga: <code>$${result.closePrice}</code>`, quickMenuKeyboard);
      } catch (err) {
        logger.error('TelegramBot', `Failed to close position ${symbol}: ${err.message}`);
        await ctx.replyWithHTML(`❌ Gagal menutup posisi ${symbol}: <code>${err.message}</code>`, quickMenuKeyboard);
      }
    });

    // /set_heartbeat <minutes> - Set heartbeat interval
    this.bot.command('set_heartbeat', async (ctx) => {
      const args = ctx.message.text.split(' ');
      const minutes = parseInt(args[1], 10);

      if (isNaN(minutes) || minutes < 0) {
        return ctx.replyWithHTML('❌ Format salah. Gunakan menit (contoh: <code>/set_heartbeat 10</code>) atau <code>0</code> untuk menonaktifkan.');
      }

      logger.info('TelegramBot', `Command /set_heartbeat ${minutes} executed by ${ctx.from.id}`);
      updateOperationalState({ heartbeatIntervalMinutes: minutes });
      this.onHeartbeatChange?.();

      if (minutes === 0) {
        await ctx.replyWithHTML('🔇 <b>Heartbeat notifikasi dinonaktifkan sementara.</b>', quickMenuKeyboard);
      } else {
        await ctx.replyWithHTML(`💓 <b>Interval heartbeat diubah menjadi:</b> <code>${minutes} menit</code>.`, quickMenuKeyboard);
      }
    });

    // /help - Show available commands
    this.bot.command('help', async (ctx) => {
      logger.info('TelegramBot', `Command /help executed by ${ctx.from.id}`);
      await this.sendHelp(ctx);
    });

    // --- Interactive Keyboard Button Listeners ---
    this.bot.hears('📊 Status', async (ctx) => {
      logger.info('TelegramBot', `Button '📊 Status' clicked by ${ctx.from.id}`);
      await this.sendStatus(ctx);
    });

    this.bot.hears('💰 Saldo', async (ctx) => {
      logger.info('TelegramBot', `Button '💰 Saldo' clicked by ${ctx.from.id}`);
      await this.sendBalance(ctx);
    });

    this.bot.hears('🔍 Screening', async (ctx) => {
      logger.info('TelegramBot', `Button '🔍 Screening' clicked by ${ctx.from.id}`);
      await this.sendScreening(ctx);
    });

    this.bot.hears('🟢 Start Strategy', async (ctx) => {
      logger.info('TelegramBot', `Button '🟢 Start Strategy' clicked by ${ctx.from.id}`);
      updateOperationalState({ isStrategyRunning: true });
      await ctx.replyWithHTML('🟢 <b>Strategy Engine DIAKTIFKAN.</b>\nBot akan memproses sinyal dan mengeksekusi order.', quickMenuKeyboard);
    });

    this.bot.hears('⏸️ Stop Strategy', async (ctx) => {
      logger.info('TelegramBot', `Button '⏸️ Stop Strategy' clicked by ${ctx.from.id}`);
      updateOperationalState({ isStrategyRunning: false });
      await ctx.replyWithHTML('⏸️ <b>Strategy Engine DIJEDA.</b>\nBot tidak akan membuka posisi baru.', quickMenuKeyboard);
    });

    this.bot.hears('💓 Heartbeat', async (ctx) => {
      logger.info('TelegramBot', `Button '💓 Heartbeat' clicked by ${ctx.from.id}`);
      try {
        await ocoManager.reconcile();
        const positions = await positionManager.getOpenPositions();
        for (const pos of positions) {
          pos.fundingRate = await positionManager.getFundingRate(pos.symbol);
        }
        const balance = await positionManager.getBalance().catch(() => null);
        await notifier.notifyHeartbeat(positions, ENV.MODE, getOperationalState().isStrategyRunning, balance);
        await ctx.replyWithHTML('💓 <i>Heartbeat monitor report telah dikirim.</i>', quickMenuKeyboard);
      } catch (err) {
        await ctx.replyWithHTML(`❌ Gagal trigger heartbeat: ${err.message}`, quickMenuKeyboard);
      }
    });

    this.bot.hears('❓ Help', async (ctx) => {
      logger.info('TelegramBot', `Button '❓ Help' clicked by ${ctx.from.id}`);
      await this.sendHelp(ctx);
    });
  }
}

export const telegramBotHandler = new TelegramBotHandler();
