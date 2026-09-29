# Binance USDS-M Futures Trading Bot

An automated trading bot for **Binance USDS-M Futures** (`*USDT` pairs) built with **Node.js**, featuring complete remote control and notifications via a **Telegram Bot**.

Designed for live validation of a multi-timeframe strategy (HTF trend bias + LTF momentum trigger + dynamic ATR-based SL/TP/Trailing Stop) on the **Binance Futures Testnet (Dry Run)** with seamless one-switch migration to **Mainnet (Production)**.

---

## 🚀 Key Features

1. **Multi-Timeframe Strategy Engine (Pluggable)**:
   - **HTF Filter (1H)**: EMA 50 vs EMA 200 determines trend bias (Uptrend: Long only; Downtrend: Short only).
   - **LTF Trigger (15M)**: Momentum RSI(14) + confirmation from MACD histogram crossover aligned with the HTF bias.
   - **Dynamic ATR Protection**: Stop Loss, Take Profit, and Trailing Stop callback rates are calculated dynamically based on ATR(14) per symbol to reflect actual volatility.
   - **State Reset on Bias Inversion**: If the HTF trend changes before an LTF trigger executes, any pending confirmation state is automatically invalidated.
2. **Smart Execution Engine & OCO Emulation**:
   - **Maker-First Entry**: Submits a `LIMIT (GTC)` order at the real-time **Best Bid / Best Ask** to minimize fees and slippage. If not filled within the configurable timeout (default 45s), it automatically cancels and falls back to a `MARKET` order.
   - **Simultaneous Triple Protection**: Places Stop Loss (`STOP_MARKET`), Take Profit (`TAKE_PROFIT_MARKET`), and Trailing Stop (`TRAILING_STOP_MARKET`) with `reduceOnly: 'true'`.
   - **Manual OCO Emulation**: Listens to `ORDER_TRADE_UPDATE` events on the Binance User Data Stream WebSocket. As soon as one exit leg fills (SL, TP, or Trailing Stop), the remaining two orders are immediately cancelled via the API.
3. **Risk Management & Precision**:
   - Fixed margin sizing per trade (default $100 USDT, customizable via Telegram).
   - Dynamic Leverage: Automatically fetches the maximum allowable leverage tier per token from `leverageBracket` (with periodic 1-hour cache TTL).
   - Enforces `CROSSED` margin mode prior to trade entry.
   - Exact symbol precision formatting via `LOT_SIZE` (stepSize floor) and `PRICE_FILTER` (tickSize round) cached from `exchangeInfo`.
   - Concurrency limits: Configurable maximum open positions (default 5) and strict single-position-per-symbol rule.
4. **Resilient Data Feed & Zero Weight Overhead**:
   - **Multiplexed Kline WebSocket**: Scans multiple symbols and timeframes in a **single TCP/WS connection**, consuming zero `REQUEST_WEIGHT`.
   - **User Data Stream**: Automatic `listenKey` keep-alive refreshed every 25 minutes.
   - **Connection Watchdog**: Automatic reconnect with exponential backoff and emergency Telegram alerts if disconnected for more than 2 minutes.
5. **Comprehensive Telegram Bot**:
   - Strict owner security guard (only responds to authorized `TELEGRAM_OWNER_CHAT_ID`).
   - Real-time push notifications: Positions opened, closed (with Realized PnL & fees), fallback to market alerts, execution errors, and heartbeat status.
   - Regular Heartbeat Monitor (default 10 minutes) displaying open positions, unrealized PnL, and live **Funding Rates**.
   - Full command suite: `/start`, `/stop`, `/status`, `/setsize`, `/setmaxpositions`, `/setmaxtokens`, `/close <symbol>`, `/set_heartbeat <minutes>`, `/help`.

---

## 📁 Directory Structure

```
telegram-binance/
├── config/
│   ├── strategy.json        # Indicator parameters, timeframes & TP:SL ratio
│   ├── risk.json            # Max positions, margin per trade, timeout, exclusions
│   └── tokens.json          # Scanned token universe & max token limit
├── state/
│   └── operational.json     # Persisted runtime state (heartbeat interval, last candles)
├── src/
│   ├── config/              # Environment & JSON config loaders (.env, .env.dryrun, .env.production)
│   ├── binance/
│   │   ├── client.js        # REST client with HMAC SHA-256 signing, time sync & retry
│   │   ├── precision.js     # LOT_SIZE & PRICE_FILTER rounding manager
│   │   ├── klineStream.js   # Multiplexed Kline WebSocket manager
│   │   └── userDataStream.js# User Data Stream listener & listenKey keep-alive
│   ├── strategy/
│   │   ├── indicators.js    # Technical indicators calculation (EMA, RSI, MACD, ATR)
│   │   └── defaultStrategy.js # Pluggable multi-timeframe strategy implementation
│   ├── execution/
│   │   ├── positionManager.js # Position sizing, leverage bracket & Cross margin
│   │   ├── ocoManager.js    # In-memory tracking, startup reconciliation & OCO cancellations
│   │   └── orderManager.js  # Limit timeout -> market fallback, exit orders & manual close
│   ├── telegram/
│   │   ├── bot.js           # Telegram bot commands handler & security guard
│   │   └── notifier.js      # Rich HTML notifications & heartbeat monitor
│   ├── utils/
│   │   └── logger.js        # Standardized timestamped logger utility
│   ├── engine.js            # Main coordinator for feed, indicators, execution & reconciliation
│   └── index.js             # Main process entrypoint & graceful shutdown handler
├── test/
│   └── smokeTest.js         # Automated smoke tests for configs, indicators & precision
├── ecosystem.config.cjs     # PM2 configuration for dry run and production instances
├── .env.example             # Environment variables template
├── package.json
└── README.md
```

---

## ⚙️ Getting Started

### 1. Prerequisites
- **Node.js** v18+ (Node.js 20 or 22 recommended)
- **Binance Futures Account** (or a [Binance Futures Testnet](https://testnet.binancefuture.com) account)
- **Telegram Bot Token** (created via [@BotFather](https://t.me/BotFather))
- **Telegram Owner Chat ID** (can be retrieved via [@userinfobot](https://t.me/userinfobot))

### 2. Installation
Clone the repository and install dependencies:
```bash
npm install
```

### 3. Environment Configuration
Copy the template to `.env`:
```bash
cp .env.example .env
```
Edit `.env` with your credentials:
```ini
# Execution Mode: dry_run (Testnet) or production (Mainnet)
MODE=dry_run

# Binance USDS-M Futures API Credentials
BINANCE_API_KEY=your_binance_api_key_here
BINANCE_API_SECRET=your_binance_api_secret_here

# Telegram Bot Credentials
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_OWNER_CHAT_ID=your_telegram_chat_id_here
```

> **Security Note:**
> Mode switching (`dry_run` vs `production`) can **only** be modified via the environment configuration file, preventing accidental live trades via Telegram.

---

## 🏃 Running the Bot

### Automated Smoke Tests
Validate configurations, precision math, and indicator calculation:
```bash
npm test
```

### Development Mode (Local Auto-Reload)
```bash
npm run dev
```

### Standard Production Start
```bash
npm start
```

### VPS Deployment via PM2
PM2 is included as a project dependency with pre-configured npm shortcuts:

```bash
# Start in Testnet (Dry Run) mode
npm run pm2:dryrun

# Start in Mainnet (Production) mode
npm run pm2:prod

# Monitor live logs
npm run pm2:logs

# Check process status and resource usage
npm run pm2:status

# Restart processes
npm run pm2:restart

# Stop processes
npm run pm2:stop
```

To configure PM2 to automatically restart upon server reboot:
```bash
npx pm2 save
npx pm2 startup
```

---

## 💬 Telegram Bot Commands

| Command | Description |
|---|---|
| `/menu` | Display interactive quick-action buttons keyboard |
| `/balance` | Check Binance Futures account wallet balance, available margin, and floating PnL (alias: `/saldo`) |
| `/screening` | Run on-demand market screening across all active tokens (also accessible via button `🔍 Screening`) |
| `/start` | Activate the strategy engine (resumes signal scanning & trade entries) |
| `/stop` | Pause the strategy engine (no new entries; existing positions remain protected) |
| `/status` | View current mode, engine status, scanned token count, and open positions with live PnL & Funding Rates |
| `/set_screening_notify <mode>` | Configure periodic 15m screening digest: `all` (default), `signals_only`, or `off` |
| `/setsize <usdt>` | Update margin per trade in USDT (e.g. `/setsize 150`) |
| `/setmaxpositions <n>` | Update maximum concurrent open positions (e.g. `/setmaxpositions 3`) |
| `/setmaxtokens <n>` | Update number of scanned tokens and dynamically reloads streams (e.g. `/setmaxtokens 15`) |
| `/close <symbol>` | Immediately close a specific position via Market order (e.g. `/close BTCUSDT`) |
| `/set_heartbeat <min>` | Adjust heartbeat notification interval (e.g. `/set_heartbeat 15`, or `0` to disable temporarily) |
| `/help` | Display command list and documentation |

---

## 📄 License
ISC License © 2026 Ryan Rafilianto
