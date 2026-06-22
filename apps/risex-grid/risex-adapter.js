import { setTimeout as sleep } from "node:timers/promises";
import { ethers } from "ethers";
import {
  ExchangeClient,
  InfoClient,
  OrderType,
  Side,
  StpMode,
  TimeInForce
} from "risex-client";

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[_\s]/g, "-");
}

function parseDecimal(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toSteps(sizeDecimal, stepSizeDecimal) {
  const steps = Math.floor(sizeDecimal / stepSizeDecimal);
  return Math.max(1, steps);
}

function toTicks(priceDecimal, tickSizeDecimal) {
  const ticks = Math.round(priceDecimal / tickSizeDecimal);
  return Math.max(1, ticks);
}

function trimTrailingSlashes(url) {
  let out = String(url || "");
  while (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, out.length - 1);
  }
  return out;
}

export class RiseXAdapter {
  constructor(options) {
    this.options = options;
    this.baseUrl = trimTrailingSlashes(options.apiBase);
    this.orderGapMs = options.orderGapMs;
    this.dryRun = options.dryRun;
    this.mode = options.mode;

    this.info = null;
    this.exchange = null;
    this.accountWallet = null;
    this.marketIndex = new Map();
    this.systemConfig = null;
    this.lastPermitResult = null;

    this._queue = Promise.resolve();
    this._initialized = false;
  }

  _enqueue(_label, fn) {
    const run = async () => {
      const out = await fn();
      await sleep(this.orderGapMs);
      return out;
    };
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  async _fetchJson(path, init) {
    const requestInit = init || {};
    const url = trimTrailingSlashes(this.baseUrl) + path;
    const resp = await fetch(url, {
      ...requestInit,
      headers: {
        "content-type": "application/json",
        ...(requestInit.headers || {})
      }
    });
    const text = await resp.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!resp.ok) {
      const msg = (body && (body.message || body.error)) || resp.statusText;
      throw new Error("HTTP " + resp.status + " " + path + ": " + msg);
    }
    return body;
  }

  _indexMarket(market) {
    const names = new Set();
    const display = normalizeSymbol(market.display_name);
    const base = normalizeSymbol(market.base_asset_symbol);
    const quote = normalizeSymbol(market.quote_asset_symbol);
    if (display) names.add(display);
    if (base) names.add(base);
    if (base && quote) names.add(base + "-" + quote);
    if (base) names.add(base + "-USD");
    if (base) names.add(base + "-PERP");
    for (const key of names) {
      this.marketIndex.set(key, market);
    }
  }

  async init() {
    if (this._initialized) return;

    if (!this.options.account || !this.options.signerKey) {
      throw new Error("missing RISEX_ACCOUNT or RISEX_SIGNER_KEY");
    }

    this.info = new InfoClient({ baseUrl: this.baseUrl, logLevel: "error" });
    this.exchange = new ExchangeClient({
      baseUrl: this.baseUrl,
      account: this.options.account,
      signerKey: this.options.signerKey,
      accountKey: this.options.accountKey || undefined,
      logLevel: "error"
    });

    await this.exchange.init();

    if (this.options.accountKey) {
      this.accountWallet = new ethers.Wallet(this.options.accountKey);
    }

    const markets = await this.info.getMarkets();
    for (const m of markets) {
      this._indexMarket(m);
    }

    this.systemConfig = await this.info.getSystemConfig();

    if (this.mode === "operator" && this.options.permitAutoApprove && !this.dryRun) {
      try {
        this.lastPermitResult = await this.approveSingleBudget({
          budgetUsd: this.options.permitBudgetUsd,
          expiryHours: this.options.permitExpiryHours
        });
      } catch (err) {
        this.lastPermitResult = {
          ok: false,
          error: err && err.message ? err.message : String(err),
          at: new Date().toISOString()
        };
      }
    }

    this._initialized = true;
  }

  _getMarket(symbol) {
    const key = normalizeSymbol(symbol);
    const market = this.marketIndex.get(key);
    if (!market) {
      throw new Error("market not found: " + symbol);
    }
    return market;
  }

  async getMidPrice(symbol) {
    if (!this._initialized) await this.init();
    const market = this._getMarket(symbol);
    const marketId = Number(market.market_id);
    const book = await this.info.getOrderbook(marketId, 1);
    const bid = parseDecimal(book && book.bids && book.bids[0] ? book.bids[0].price : 0, 0);
    const ask = parseDecimal(book && book.asks && book.asks[0] ? book.asks[0].price : 0, 0);

    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    if (bid > 0) return bid;
    if (ask > 0) return ask;

    const mark = parseDecimal(market.mark_price, 0);
    if (mark > 0) return mark;

    const last = parseDecimal(market.last_price, 0);
    if (last > 0) return last;

    throw new Error("cannot get mid price: " + symbol);
  }

  async listOpenOrders(symbol) {
    if (!this._initialized) await this.init();
    const market = this._getMarket(symbol);
    const marketId = Number(market.market_id);
    return this.info.getOpenOrders(this.options.account, marketId);
  }

  async cancelAll(symbol) {
    if (this.dryRun) {
      return { ok: true, mode: "dryRun", symbol: symbol || "ALL" };
    }
    if (!this._initialized) await this.init();

    if (!symbol) {
      return this._enqueue("cancelAll:all", async () => this.exchange.cancelAllOrders(0));
    }

    const market = this._getMarket(symbol);
    return this._enqueue("cancelAll:" + market.display_name, async () =>
      this.exchange.cancelAllOrders(Number(market.market_id))
    );
  }

  async placeLimitOrder(input) {
    const symbol = input.symbol;
    const side = input.side;
    const price = input.price;
    const size = input.size;
    const reduceOnly = !!input.reduceOnly;
    const postOnly = !!input.postOnly;

    if (!this._initialized) await this.init();

    const market = this._getMarket(symbol);
    const marketId = Number(market.market_id);

    const stepSize = parseDecimal(market.config && market.config.step_size ? market.config.step_size : 0, 0);
    const stepPrice = parseDecimal(market.config && market.config.step_price ? market.config.step_price : 0, 0);
    if (!(stepSize > 0) || !(stepPrice > 0)) {
      throw new Error("invalid market step config: " + symbol);
    }

    const sizeSteps = toSteps(size, stepSize);
    const priceTicks = toTicks(price, stepPrice);
    const sideEnum = String(side).toLowerCase() === "buy" ? Side.Long : Side.Short;

    if (this.dryRun) {
      return {
        ok: true,
        mode: "dryRun",
        market: market.display_name,
        marketId: marketId,
        side: side,
        size: size,
        price: price,
        sizeSteps: sizeSteps,
        priceTicks: priceTicks,
        orderId: "dry-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8)
      };
    }

    return this._enqueue("place:" + market.display_name, async () => {
      const resp = await this.exchange.placeOrder({
        market_id: marketId,
        side: sideEnum,
        order_type: OrderType.Limit,
        price_ticks: priceTicks,
        size_steps: sizeSteps,
        time_in_force: TimeInForce.GoodTillCancelled,
        post_only: postOnly,
        reduce_only: reduceOnly,
        stp_mode: StpMode.ExpireMaker,
        ttl_units: 0
      });

      return {
        ok: true,
        market: market.display_name,
        marketId: marketId,
        side: side,
        size: size,
        price: price,
        sizeSteps: sizeSteps,
        priceTicks: priceTicks,
        orderId: resp.order_id,
        txHash: resp.tx_hash,
        scOrderId: resp.sc_order_id
      };
    });
  }

  _resolveOperatorAddress(systemConfig) {
    const addresses = systemConfig && systemConfig.addresses ? systemConfig.addresses : {};
    return addresses.operator_hub || addresses.operatorHub || addresses.operator || "";
  }

  async approveSingleBudget(args) {
    const budgetUsd = Number(args && args.budgetUsd ? args.budgetUsd : this.options.permitBudgetUsd);
    const expiryHours = Number(args && args.expiryHours ? args.expiryHours : this.options.permitExpiryHours);

    if (this.dryRun) {
      return {
        ok: true,
        mode: "dryRun",
        budgetUsd: budgetUsd,
        expiryHours: expiryHours,
        at: new Date().toISOString()
      };
    }

    if (!this.accountWallet) {
      throw new Error("missing RISEX_ACCOUNT_KEY for PermitSingle signing");
    }

    if (!this._initialized) await this.init();

    const systemConfig = this.systemConfig || (await this.info.getSystemConfig());
    const operator = this._resolveOperatorAddress(systemConfig);
    if (!operator) {
      throw new Error("operator_hub not found in system config");
    }

    const domainResp = await this._fetchJson("/v1/auth/eip712-domain");
    const nonceState = await this._fetchJson("/v1/nonce-state/" + this.options.account);

    let nonceAnchor = BigInt(nonceState.nonce_anchor || "0");
    let bitmapIndex = Number(nonceState.current_bitmap_index ?? 0);
    if (bitmapIndex >= 208) {
      nonceAnchor += 1n;
      bitmapIndex = 0;
    }

    const allowanceExpiry = Math.floor(Date.now() / 1000) + Math.max(1, expiryHours) * 3600;
    const budgetWad = ethers.parseUnits(String(budgetUsd), 18).toString();

    const domain = {
      name: domainResp.name,
      version: String(domainResp.version),
      chainId: BigInt(domainResp.chain_id),
      verifyingContract: domainResp.verifying_contract
    };

    const types = {
      PermitSingle: [
        { name: "account", type: "address" },
        { name: "operator", type: "address" },
        { name: "budget", type: "uint96" },
        { name: "allowanceExpiry", type: "uint32" },
        { name: "nonceAnchor", type: "uint48" },
        { name: "nonceBitmap", type: "uint8" }
      ]
    };

    const value = {
      account: this.options.account,
      operator: operator,
      budget: budgetWad,
      allowanceExpiry: allowanceExpiry,
      nonceAnchor: nonceAnchor.toString(),
      nonceBitmap: bitmapIndex
    };

    const signature = await this.accountWallet.signTypedData(domain, types, value);

    const payload = {
      account: this.options.account,
      operator: operator,
      budget: budgetWad,
      allowance_expiry: allowanceExpiry,
      nonce_anchor: nonceAnchor.toString(),
      nonce_bitmap_index: bitmapIndex,
      signature: signature
    };

    const result = await this._fetchJson("/v1/auth/approve-single", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    this.lastPermitResult = {
      ok: true,
      at: new Date().toISOString(),
      operator: operator,
      budgetUsd: budgetUsd,
      budgetWad: budgetWad,
      allowanceExpiry: allowanceExpiry,
      response: result
    };

    return this.lastPermitResult;
  }

  snapshot() {
    return {
      initialized: this._initialized,
      mode: this.mode,
      dryRun: this.dryRun,
      account: this.options.account,
      signer: this.exchange && this.exchange.signer ? this.exchange.signer : "",
      marketsIndexed: this.marketIndex.size,
      operatorHub: this._resolveOperatorAddress(this.systemConfig),
      lastPermitResult: this.lastPermitResult
    };
  }
}


