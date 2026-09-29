import { ENV, getOperationalState } from '../config/index.js';
import { logger } from '../utils/logger.js';

class TelegramNotifier {
  constructor() {
    this.bot = null;
    this.ownerChatId = ENV.TELEGRAM_OWNER_CHAT_ID;
  }

  setBot(botInstance) {
    this.bot = botInstance;
  }

  async send(text, parseMode = 'HTML') {
    if (!this.bot || !this.ownerChatId) {
      logger.info('Notifier', `[No Bot/ChatID configured] Preview:\n${text}`);
      return;
    }
    try {
      await this.bot.telegram.sendMessage(this.ownerChatId, text, {
        parse_mode: parseMode,
        disable_web_page_preview: true,
      });
      logger.info('Notifier', 'Push notification sent to owner successfully.');
    } catch (err) {
      logger.error('Notifier', `Failed to send Telegram message: ${err.message}`);
    }
  }

  async notifyPositionOpened(data) {
    const icon = data.direction === 'LONG' ? '🟢' : '🔴';
    const fallbackNote = data.fallbackToMarket ? '\n⚠️ <i>Entry via Market (Limit order timed out)</i>' : '';

    const message = `
<b>${icon} POSISI DIBUKA: ${data.symbol} [${data.direction}]</b>${fallbackNote}

• <b>Entry Price:</b> <code>$${data.entryPrice}</code>
• <b>Quantity:</b> <code>${data.quantity}</code> (${data.leverage}x Cross)
• <b>Margin:</b> <code>$${data.margin} USDT</code>
• <b>Stop Loss:</b> <code>$${data.stopLossPrice}</code>
• <b>Take Profit:</b> <code>$${data.takeProfitPrice}</code>
• <b>Trailing Stop:</b> <code>${data.trailingCallbackRate}%</code> callback
• <b>Waktu:</b> <code>${new Date().toLocaleTimeString()}</code>
`.trim();

    await this.send(message);
  }

  async notifyPositionClosed(data) {
    const isProfit = (data.realizedProfit || 0) >= 0;
    const pnlIcon = isProfit ? '💰' : '🛑';
    const sign = isProfit ? '+' : '';

    const message = `
<b>${pnlIcon} POSISI DITUTUP: ${data.symbol}</b>

• <b>Alasan:</b> <code>${data.exitType}</code>
• <b>Harga Close:</b> <code>$${data.price}</code>
• <b>Realized PnL:</b> <code>${sign}$${(data.realizedProfit || 0).toFixed(2)} USDT</code>
• <b>Fee Komisi:</b> <code>${data.commission || 0} ${data.commissionAsset || 'USDT'}</code>
• <b>Waktu:</b> <code>${new Date(data.time).toLocaleTimeString()}</code>
`.trim();

    await this.send(message);
  }

  async notifyFallbackToMarket(data) {
    const message = `
<b>⚠️ ORDER FALLBACK TO MARKET</b>
Order Limit untuk <b>${data.symbol} (${data.direction})</b> tidak terisi dalam batas waktu.
Otomatis switch ke <b>MARKET ORDER</b>...
`.trim();
    await this.send(message);
  }

  async notifyExecutionError(symbol, action, errorMsg) {
    const message = `
<b>🚨 ERROR EKSEKUSI</b>
• <b>Pair:</b> <code>${symbol}</code>
• <b>Action:</b> <code>${action}</code>
• <b>Pesan:</b> <code>${errorMsg}</code>
`.trim();
    await this.send(message);
  }

  async notifyBotStatus(status, details = '') {
    const icon = status === 'STARTED' ? '🚀' : status === 'STOPPED' ? '⏸️' : 'ℹ️';
    const message = `
<b>${icon} BOT STATUS: ${status}</b>
${details}
• <b>Waktu:</b> <code>${new Date().toLocaleString()}</code>
`.trim();
    await this.send(message);
  }

  formatScreeningSummary(summary) {
    if (!summary || summary.totalScanned === 0) {
      return '🔍 <b>HASIL SCREENING PASAR (15M)</b>\n<i>Belum ada data candle atau screening sedang diproses...</i>';
    }

    const timeStr = new Date(summary.timestamp).toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    let signalSection = '';
    if (summary.signals && summary.signals.length > 0) {
      const sigLines = summary.signals.map((s) => {
        const icon = s.signal === 'LONG' ? '🟢' : '🔴';
        const rsiStr = s.indicators?.rsi !== undefined ? Number(s.indicators.rsi).toFixed(1) : '-';
        const macdStr = s.indicators?.macdHist !== undefined ? Number(s.indicators.macdHist).toFixed(4) : '-';
        return `• ${icon} <b>${s.symbol} [${s.signal}]</b> @ <code>$${s.entryPrice}</code>\n  RSI: <code>${rsiStr}</code> | MACD Hist: <code>${macdStr}</code>\n  SL: <code>$${s.stopLossPrice}</code> | TP: <code>$${s.takeProfitPrice}</code>`;
      });
      const isFull = summary.openPositionsCount !== undefined && summary.maxOpenPositions !== undefined && summary.openPositionsCount >= summary.maxOpenPositions;
      const fullNote = isFull ? `\n⚠️ <i>(Order tidak dieksekusi otomatis karena kuota posisi ${summary.maxOpenPositions}/${summary.maxOpenPositions} penuh)</i>` : '';
      signalSection = `🎯 <b>SINYAL ENTRY VALID (${summary.signals.length}):</b>\n${sigLines.join('\n')}${fullNote}`;
    } else {
      signalSection = '🎯 <b>SINYAL ENTRY:</b>\n<i>Tidak ada sinyal entry pada siklus 15m ini.</i>';
    }

    let watchlistSection = '';
    if (summary.watchlist && summary.watchlist.length > 0) {
      const topWatch = summary.watchlist.slice(0, 5);
      const watchLines = topWatch.map((w) => {
        const icon = w.htfBias === 'LONG' ? '🟢' : '🔴';
        const rsiStr = w.rsi !== undefined ? Number(w.rsi).toFixed(1) : '-';
        const macdStr = w.macdHist !== undefined ? Number(w.macdHist).toFixed(4) : '-';
        return `• ${icon} <b>${w.symbol}</b> (RSI: <code>${rsiStr}</code> | Hist: <code>${macdStr}</code>)\n  <i>${w.waitingReason || 'Menunggu konfirmasi'}</i>`;
      });
      watchlistSection = `\n\n👀 <b>POTENSI SETUP TERDEKAT (${summary.watchlist.length}):</b>\n${watchLines.join('\n')}`;
    }

    let biasSection = '';
    if (summary.biasSummary) {
      const { bullish = [], bearish = [], neutral = [] } = summary.biasSummary;
      const cleanSymbols = (arr) => (arr.length > 0 ? arr.map((s) => s.replace('USDT', '')).join(', ') : '<i>tidak ada</i>');
      biasSection = `\n\n📈 <b>TREN HTF (1H):</b>
• 🟢 <b>Bullish (${bullish.length}):</b> ${cleanSymbols(bullish)}
• 🔴 <b>Bearish (${bearish.length}):</b> ${cleanSymbols(bearish)}
• ⚪ <b>Netral (${neutral.length}):</b> ${cleanSymbols(neutral)}`;
    }

    let slotText = '';
    if (summary.openPositionsCount !== undefined && summary.maxOpenPositions !== undefined) {
      if (summary.openPositionsCount >= summary.maxOpenPositions) {
        slotText = `\n🔒 <b>Slot Posisi:</b> <code>${summary.openPositionsCount}/${summary.maxOpenPositions}</code> (<b>Penuh</b> - order baru dijeda)`;
      } else {
        const avail = summary.maxOpenPositions - summary.openPositionsCount;
        slotText = `\n🔓 <b>Slot Posisi:</b> <code>${summary.openPositionsCount}/${summary.maxOpenPositions}</code> (Tersedia <b>${avail}</b> slot)`;
      }
    }

    const state = getOperationalState();
    const modeLabel = (state.screeningNotifyMode || 'all').toUpperCase();

    return `
🔍 <b>HASIL SCREENING PASAR (15M)</b>
⏰ <b>Waktu:</b> <code>${timeStr}</code>
📊 <b>Dipindai:</b> <code>${summary.totalScanned} tokens</code>${slotText}

${signalSection}${watchlistSection}${biasSection}

🔔 <i>Notif Mode: <b>${modeLabel}</b> (/set_screening_notify)</i>
`.trim();
  }

  async notifyScreeningSummary(summary) {
    const message = this.formatScreeningSummary(summary);
    await this.send(message);
  }

  async notifyHeartbeat(positions, mode, isRunning, balance = null) {
    const statusText = isRunning ? '🟢 Aktif' : '⏸️ Berhenti';
    const modeText = mode === 'production' ? '🔥 Mainnet (Production)' : '🧪 Testnet (Dry Run)';
    const balText = balance
      ? `\n• <b>Saldo Wallet:</b> <code>$${balance.walletBalance.toFixed(2)} USDT</code> (Tersedia: <code>$${balance.availableBalance.toFixed(2)}</code>)`
      : '';

    if (!positions || positions.length === 0) {
      const message = `
<b>💓 Heartbeat Monitor</b>
• <b>Mode:</b> ${modeText}
• <b>Status Strategy:</b> ${statusText}${balText}
• <b>Posisi Terbuka:</b> <i>Tidak ada posisi terbuka saat ini.</i>
• <b>Waktu:</b> <code>${new Date().toLocaleTimeString()}</code>
`.trim();
      return this.send(message);
    }

    let posLines = '';
    let totalUnrealized = 0;

    for (const pos of positions) {
      const amt = parseFloat(pos.positionAmt);
      const dir = amt > 0 ? '🟢 LONG' : '🔴 SHORT';
      const pnl = parseFloat(pos.unRealizedProfit);
      totalUnrealized += pnl;
      const sign = pnl >= 0 ? '+' : '';

      const fundingText = pos.fundingRate !== undefined ? ` | Funding: <code>${pos.fundingRate >= 0 ? '+' : ''}${pos.fundingRate.toFixed(4)}%</code>` : '';

      posLines += `
• <b>${pos.symbol}</b> (${dir} ${pos.leverage}x)
  Entry: <code>$${parseFloat(pos.entryPrice)}</code> | PnL: <code>${sign}$${pnl.toFixed(2)} USDT</code>${fundingText}`;
    }

    const totalSign = totalUnrealized >= 0 ? '+' : '';
    const message = `
<b>💓 Heartbeat Monitor</b>
• <b>Mode:</b> ${modeText}
• <b>Status Strategy:</b> ${statusText}${balText}
• <b>Total UnRealized PnL:</b> <code>${totalSign}$${totalUnrealized.toFixed(2)} USDT</code>

<b>Daftar Posisi (${positions.length}):</b>${posLines}

• <b>Waktu:</b> <code>${new Date().toLocaleTimeString()}</code>
`.trim();

    await this.send(message);
  }
}

export const notifier = new TelegramNotifier();
