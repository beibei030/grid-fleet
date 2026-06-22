// Minimal .env loader (no external dependency) + config assembly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

export function getConfig() {
  loadEnv();
  // 实盘（LIVE），仅主网（mainnet = 真实价格 / 真实资金）。
  // EXTENDED_API_URL 可显式覆盖默认接口地址。
  return {
    network: 'mainnet',
    port: Number(process.env.PORT || 8080),
    // Extended credentials (app.extended.exchange -> API Management)
    apiKey: process.env.EXTENDED_API_KEY || '',
    // 兼容 EXTENDED_VAULT / EXTENDED_VAULT_ID 两种命名
    vault: process.env.EXTENDED_VAULT || process.env.EXTENDED_VAULT_ID || '',
    starkPrivateKey: process.env.EXTENDED_STARK_PRIVATE_KEY || '',
    starkPublicKey: process.env.EXTENDED_STARK_PUBLIC_KEY || '',
    feeRate: process.env.EXTENDED_MAX_FEE || '0.0005',
    apiUrl: (process.env.EXTENDED_API_URL || 'https://api.starknet.extended.exchange').replace(/\/$/, ''),
    proxy: process.env.EXTENDED_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
    /** 非空时 /api/start、/api/stop 需 Bearer 令牌（VPS 暴露端口时建议开启） */
    authToken: process.env.GRID_AUTH_TOKEN || '',
  };
}

export const ROOT = root;
