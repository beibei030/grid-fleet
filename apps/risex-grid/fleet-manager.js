import { GridBot } from "./grid-bot.js";

export class FleetManager {
  constructor({ adapter, markets, gridCount, halfRangePct, budgetUsd }) {
    this.adapter = adapter;
    this.bots = new Map();
    for (const symbol of markets) {
      this.bots.set(
        symbol,
        new GridBot({ symbol, adapter, gridCount, halfRangePct, budgetUsd })
      );
    }
    this.restarting = false;
    this.lastError = null;
  }

  async restart({ symbols }) {
    if (this.restarting) {
      return { ok: false, message: "fleet restarting" };
    }

    this.restarting = true;
    const errors = [];

    try {
      const targets = symbols && symbols.length ? symbols : [...this.bots.keys()];
      for (const symbol of targets) {
        const bot = this.bots.get(symbol);
        if (!bot) continue;

        try {
          await bot.stop();
          await bot.start();
        } catch (err) {
          const msg = err?.message || String(err);
          errors.push(symbol + ": " + msg);
        }
      }

      if (errors.length > 0) {
        this.lastError = errors.join(" | ");
        return { ok: false, message: this.lastError };
      }

      this.lastError = null;
      return { ok: true, restarted: targets };
    } finally {
      this.restarting = false;
    }
  }

  async pauseAll() {
    for (const bot of this.bots.values()) {
      await bot.pause();
    }
  }

  async resumeAll() {
    for (const bot of this.bots.values()) {
      if (!bot.running) {
        await bot.start();
      }
    }
  }

  async stopAll() {
    for (const bot of this.bots.values()) {
      await bot.stop();
    }
  }

  async maintain() {
    for (const bot of this.bots.values()) {
      await bot.maintain();
    }
  }

  snapshot() {
    return {
      restarting: this.restarting,
      lastError: this.lastError,
      bots: [...this.bots.values()].map((b) => b.snapshot())
    };
  }
}
