function round(value, digits = 8) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function buildGridLevels(mid, count, halfRangePct) {
  const levels = [];
  if (count < 2) return [round(mid, 6)];
  const step = (halfRangePct * 2) / (count - 1);
  for (let i = 0; i < count; i += 1) {
    const offsetPct = -halfRangePct + step * i;
    levels.push(round(mid * (1 + offsetPct), 6));
  }
  return levels;
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label + " timeout")), timeoutMs);
    })
  ]);
}

export class GridBot {
  constructor({ symbol, adapter, gridCount, halfRangePct, budgetUsd }) {
    this.symbol = symbol;
    this.adapter = adapter;
    this.gridCount = gridCount;
    this.halfRangePct = halfRangePct;
    this.budgetUsd = budgetUsd;

    this.running = false;
    this.lastMidPrice = 0;
    this.lastLevels = [];
    this.openOrders = [];
    this.lastActionAt = null;
    this.lastError = null;
  }

  async start() {
    this.running = true;
    await this.seed();
  }

  async pause() {
    this.running = false;
  }

  async stop() {
    this.running = false;
    await withTimeout(this.adapter.cancelAll(this.symbol), 45000, this.symbol + " cancelAll");
    this.openOrders = [];
    this.lastLevels = [];
    this.lastActionAt = new Date().toISOString();
  }

  async seed(midPrice) {
    const mid = midPrice || (await withTimeout(this.adapter.getMidPrice(this.symbol), 30000, this.symbol + " getMidPrice"));
    this.lastMidPrice = mid;

    const levels = buildGridLevels(mid, this.gridCount, this.halfRangePct);
    const perOrderUsd = this.budgetUsd / this.gridCount;

    const nextOrders = [];
    let failedCount = 0;

    for (const price of levels) {
      const side = price < mid ? "buy" : "sell";
      const size = round(perOrderUsd / price, 8);
      try {
        const placed = await withTimeout(
          this.adapter.placeLimitOrder({
            symbol: this.symbol,
            side,
            price,
            size,
            reduceOnly: false,
            postOnly: false
          }),
          45000,
          this.symbol + " placeLimitOrder"
        );

        nextOrders.push({
          orderId: placed.orderId || null,
          side,
          price,
          size,
          status: "open"
        });
      } catch (err) {
        failedCount += 1;
        this.lastError = err && err.message ? err.message : String(err);
      }
    }

    this.lastLevels = levels;
    this.openOrders = nextOrders;
    this.lastActionAt = new Date().toISOString();
    if (failedCount === 0) {
      this.lastError = null;
    }
  }

  async recenter(midPrice) {
    await withTimeout(this.adapter.cancelAll(this.symbol), 45000, this.symbol + " recenter-cancelAll");
    await this.seed(midPrice);
  }

  _isOutOfRange(mid) {
    if (!this.lastLevels.length) return true;
    const min = this.lastLevels[0];
    const max = this.lastLevels[this.lastLevels.length - 1];
    return mid < min || mid > max;
  }

  async maintain() {
    if (!this.running) return;

    try {
      const liveOrders = await withTimeout(this.adapter.listOpenOrders(this.symbol), 30000, this.symbol + " listOpenOrders");
      const openCount = Array.isArray(liveOrders) ? liveOrders.length : 0;

      const mid = await withTimeout(this.adapter.getMidPrice(this.symbol), 30000, this.symbol + " maintain-getMidPrice");
      this.lastMidPrice = mid;

      const needRecenter =
        openCount !== this.gridCount ||
        this.openOrders.length !== this.gridCount ||
        this._isOutOfRange(mid);

      if (needRecenter) {
        await this.recenter(mid);
      }
    } catch (err) {
      this.lastError = err?.message || String(err);
      throw err;
    }
  }

  snapshot() {
    return {
      symbol: this.symbol,
      running: this.running,
      gridCount: this.gridCount,
      openOrders: this.openOrders.length,
      lastMidPrice: this.lastMidPrice,
      lastActionAt: this.lastActionAt,
      lastError: this.lastError
    };
  }
}
