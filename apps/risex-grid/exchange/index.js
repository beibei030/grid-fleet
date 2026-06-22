import { RiseExchange } from './risex.js';

export function createExchange(cfg) {
  if (!cfg.account || !cfg.signerKey) {
    throw new Error('实盘需要 RISEX_ACCOUNT 和 RISEX_SIGNER_KEY（在 rise.trade → Settings → API Keys 创建 API Signer，填入 .env）。');
  }
  return new RiseExchange({
    account: cfg.account,
    signerKey: cfg.signerKey,
    apiUrl: cfg.apiUrl,
    wsUrl: cfg.wsUrl,
  });
}
