import { config, isPaper } from "../config.js";
import { DecibelExchange } from "./decibelExchange.js";
import { PaperExchange } from "./paperExchange.js";
import type { ExchangeAdapter } from "./types.js";

export interface Exchanges {
  decibel: ExchangeAdapter;
  byName(name: string): ExchangeAdapter;
  all(): ExchangeAdapter[];
}

export function createExchanges(): Exchanges {
  const decibel: ExchangeAdapter = isPaper
    ? new PaperExchange({
        name: "Decibel",
        startEquity: 1000,
        takerFee: 0.00034,
        basis: 0,
        fundingBias: -0.0001,
      })
    : new DecibelExchange();

  return {
    decibel,
    byName(name: string) {
      const n = name.toLowerCase();
      if (n.startsWith("dec")) return decibel;
      throw new Error(`unknown exchange ${name}`);
    },
    all() {
      return [decibel];
    },
  };
}

export { config };
