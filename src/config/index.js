import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../');

// Load base .env first
const baseEnvPath = path.resolve(ROOT_DIR, '.env');
if (fs.existsSync(baseEnvPath)) {
  dotenv.config({ path: baseEnvPath });
}

// Overlay specific environment file (e.g. .env.dryrun or .env.production)
const envFile = process.env.ENV_FILE;
if (envFile && envFile !== '.env') {
  const targetEnvPath = path.resolve(ROOT_DIR, envFile);
  if (fs.existsSync(targetEnvPath)) {
    dotenv.config({ path: targetEnvPath, override: true });
  }
}

const PATHS = {
  strategy: path.join(ROOT_DIR, 'config/strategy.json'),
  risk: path.join(ROOT_DIR, 'config/risk.json'),
  tokens: path.join(ROOT_DIR, 'config/tokens.json'),
  state: path.join(ROOT_DIR, 'state/operational.json'),
};

function readJsonFile(filePath, defaultFallback = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(defaultFallback, null, 2), 'utf-8');
      return defaultFallback;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`[Config] Failed reading ${filePath}:`, error.message);
    return defaultFallback;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error(`[Config] Failed writing ${filePath}:`, error.message);
  }
}

export const ENV = {
  MODE: (process.env.MODE || 'dry_run').toLowerCase(),
  BINANCE_API_KEY: process.env.BINANCE_API_KEY || '',
  BINANCE_API_SECRET: process.env.BINANCE_API_SECRET || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_OWNER_CHAT_ID: process.env.TELEGRAM_OWNER_CHAT_ID ? String(process.env.TELEGRAM_OWNER_CHAT_ID).trim() : '',
};

export const IS_PRODUCTION = ENV.MODE === 'production';

export const ENDPOINTS = {
  rest: IS_PRODUCTION
    ? 'https://fapi.binance.com'
    : 'https://testnet.binancefuture.com',
  ws: IS_PRODUCTION
    ? 'wss://fstream.binance.com'
    : 'wss://stream.binancefuture.com',
};

// Config getters & setters
export function getStrategyConfig() {
  return readJsonFile(PATHS.strategy);
}

export function updateStrategyConfig(updates) {
  const current = getStrategyConfig();
  const updated = { ...current, ...updates };
  writeJsonFile(PATHS.strategy, updated);
  return updated;
}

export function getRiskConfig() {
  return readJsonFile(PATHS.risk);
}

export function updateRiskConfig(updates) {
  const current = getRiskConfig();
  const updated = { ...current, ...updates };
  writeJsonFile(PATHS.risk, updated);
  return updated;
}

export function getTokensConfig() {
  return readJsonFile(PATHS.tokens);
}

export function updateTokensConfig(updates) {
  const current = getTokensConfig();
  const updated = { ...current, ...updates };
  writeJsonFile(PATHS.tokens, updated);
  return updated;
}

export function getOperationalState() {
  return readJsonFile(PATHS.state, {
    isStrategyRunning: true,
    heartbeatIntervalMinutes: 10,
    screeningNotifyMode: 'all',
    lastProcessedCandles: {},
    pendingSignals: {},
  });
}

export function updateOperationalState(updates) {
  const current = getOperationalState();
  const updated = { ...current, ...updates };
  writeJsonFile(PATHS.state, updated);
  return updated;
}
