import { ExtendedExchange } from './extended.js';

/** Factory: build the LIVE Extended adapter (实盘，仅此一种). */
export function createExchange(cfg) {
  if (!cfg.apiKey || !cfg.vault || !cfg.starkPrivateKey) {
    throw new Error('实盘需要 EXTENDED_API_KEY、EXTENDED_VAULT 和 EXTENDED_STARK_PRIVATE_KEY 环境变量（在 app.extended.exchange 的 API Management 页面获取，填入 .env）。');
  }
  return new ExtendedExchange({
    apiKey: cfg.apiKey, vault: cfg.vault,
    privateKey: cfg.starkPrivateKey, publicKey: cfg.starkPublicKey || null,
    apiUrl: cfg.apiUrl, network: cfg.network, feeRate: cfg.feeRate,
  });
}
