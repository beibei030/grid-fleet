import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

export function getConfig() {
  loadEnv();
  return {
    network: 'mainnet',
    port: Number(process.env.PORT || 8082),
    account: process.env.RISEX_ACCOUNT || '',
    signerKey: process.env.RISEX_SIGNER_KEY || '',
    apiUrl: (process.env.RISEX_API_URL || 'https://api.rise.trade').replace(/\/$/, ''),
    wsUrl: process.env.RISEX_WS_URL || 'wss://ws.rise.trade/ws',
    proxy: process.env.RISEX_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
    authToken: process.env.GRID_AUTH_TOKEN || '',
  };
}

export const ROOT = root;
