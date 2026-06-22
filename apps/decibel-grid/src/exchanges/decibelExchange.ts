import type {
  DecibelConfig,
  DecibelReadDex,
  DecibelWriteDex,
} from "@decibeltrade/sdk";
import type { Account } from "@aptos-labs/ts-sdk";
import type {
  AccountStats,
  Balance,
  ExchangeAdapter,
  HedgeSettlementQuery,
  HedgeTradeSettlement,
  NormalizedTrade,
  MarketInfo,
  OpenOrderView,
  OrderResult,
  PlaceOrderParams,
  Position,
  Side,
} from "./types.js";
import { config, isPaper } from "../config.js";
import { log } from "../util/logger.js";

interface MarketCfg {
  market_addr: string;
  market_name: string;
  sz_decimals: number;
  px_decimals: number;
  max_leverage: number;
  tick_size: number; // chain units
  min_size: number; // chain units
  lot_size: number; // chain units
}

/** 从市场名取基础币代号，例如 "BTC-USD" / "BTC/USD" -> "BTC" */
function baseSymbol(marketName: string): string {
  return marketName.split(/[-/_]/)[0].toUpperCase();
}

/**
 * Decibel 真实适配器（Aptos 链上永续，@decibeltrade/sdk）。
 * 用动态 import 加载 SDK，避免 paper 模式下也加载重型依赖。
 */
export class DecibelExchange implements ExchangeAdapter {
  readonly name = "Decibel";

  private read!: DecibelReadDex;
  private write!: DecibelWriteDex;
  private account!: Account;
  private subaccount!: string;
  private sdk!: typeof import("@decibeltrade/sdk");
  private markets: MarketCfg[] = [];
  private byBase = new Map<string, MarketCfg>();
  private addrToBase = new Map<string, string>();
  private priceCache?: { ts: number; byAddr: Map<string, any> };
  private tradeStatsCache?: { ts: number; sinceMs: number; fees: number };
  private officialStatsCache?: {
    ts: number;
    volume: number;
    fees: number;
    realizedPnl: number;
    tradeCount: number;
    recentClosed: {
      market: string;
      closedTime: number;
      realizedPnl: number;
      side: string;
      size: number;
      exitPrice: number;
      fees: number;
    }[];
  };

  async init(): Promise<void> {
    if (!config.decibel.apiKey || !config.decibel.privateKey) {
      throw new Error(
        "Decibel 凭证缺失：请在 .env 配置 DECIBEL_API_KEY（Geomi Node API Key）与 DECIBEL_ACCOUNT_PRIVATE_KEY（Aptos 私钥），见 README。"
      );
    }

    const sdk = await import("@decibeltrade/sdk");
    const aptos = await import("@aptos-labs/ts-sdk");
    this.sdk = sdk;

    const baseCfg: DecibelConfig = config.mode === "mainnet" ? sdk.MAINNET_CONFIG : sdk.TESTNET_CONFIG;
    // 可选：Geomi Gas Station 代付 gas（免持有 APT）
    const netCfg: DecibelConfig = config.decibel.gasStationApiKey
      ? {
          ...baseCfg,
          gasStationApiKey: config.decibel.gasStationApiKey,
          gasStationUrl:
            config.mode === "mainnet"
              ? "https://api.mainnet.aptoslabs.com/gs/v1"
              : "https://api.testnet.aptoslabs.com/gs/v1",
        }
      : baseCfg;

    // 兼容 AIP-80 形式（ed25519-priv-0x...）与裸 0x。AIP-80 串直接传可避免 SDK 警告。
    const priv = config.decibel.privateKey.trim();
    this.account = new aptos.Ed25519Account({
      privateKey: new aptos.Ed25519PrivateKey(priv),
    });

    this.read = new sdk.DecibelReadDex(netCfg, {
      nodeApiKey: config.decibel.apiKey,
      onWsError: (e) => log.warn(`[Decibel] WS: ${String(e)}`),
    });

    const gas = new sdk.GasPriceManager(netCfg);
    await gas.initialize().catch(() => {});
    this.write = new sdk.DecibelWriteDex(netCfg, this.account, {
      nodeApiKey: config.decibel.apiKey,
      gasPriceManager: gas,
      // Geomi Gas Station 下 simulate.simple 偶发非数组返回，跳过模拟直接提交
      skipSimulate: !!config.decibel.gasStationApiKey,
    });

    // 解析交易子账户
    this.subaccount =
      config.decibel.subaccount ||
      sdk.getPrimarySubaccountAddr(this.account.accountAddress, netCfg.compatVersion, netCfg.deployment.package);

    await this.refreshMarkets();
    log.info(
      `[Decibel] 已连接 | API钱包(签名/付gas)地址 ${this.account.accountAddress.toString()} | 子账户 ${this.subaccount.slice(0, 10)}… | ${this.markets.length} 个市场 | gas:${config.decibel.gasStationApiKey ? "GasStation代付" : "需APT"}`
    );
  }

  private async refreshMarkets() {
    const ms = (await this.read.markets.getAll()) as MarketCfg[];
    this.markets = ms.filter((m) => (m as any).mode === "Open" || true);
    this.byBase.clear();
    this.addrToBase.clear();
    for (const m of this.markets) {
      const base = baseSymbol(m.market_name);
      if (!this.byBase.has(base)) this.byBase.set(base, m);
      this.addrToBase.set(m.market_addr, base);
    }
  }

  private cfg(symbol: string): MarketCfg | undefined {
    return this.byBase.get(symbol.toUpperCase());
  }

  /** Decibel open-order API 可能返回人类可读价/量，也可能返回链上整数；与 mark 对比自动识别 */
  private parseApiPrice(raw: number, m: MarketCfg, markHint = 0): number {
    if (!(raw > 0)) return 0;
    const scaled = raw / 10 ** m.px_decimals;
    if (markHint > 0) {
      const nearMark = (v: number) => v > markHint * 0.05 && v < markHint * 20;
      if (nearMark(raw)) return raw;
      if (nearMark(scaled)) return scaled;
    }
    if (raw >= 1e7) return scaled;
    return raw;
  }

  private parseApiSize(raw: number, m: MarketCfg): number {
    if (!(raw > 0)) return 0;
    const scaled = raw / 10 ** m.sz_decimals;
    if (raw < 1e5 && scaled < raw * 0.01) return raw;
    if (raw >= 1e6) return scaled;
    return raw;
  }

  // 价格缓存（~4s），避免逐币/每 tick 重复请求触发 Geomi 限流
  private async pricesByAddr(): Promise<Map<string, any>> {
    const now = Date.now();
    if (this.priceCache && now - this.priceCache.ts < 4000) return this.priceCache.byAddr;
    const prices = await this.read.marketPrices.getAll();
    const byAddr = new Map(prices.map((p) => [p.market, p]));
    this.priceCache = { ts: now, byAddr };
    return byAddr;
  }

  // ---- 行情 ----
  async getMarkets(): Promise<MarketInfo[]> {
    const priceByAddr = await this.pricesByAddr();
    const out: MarketInfo[] = [];
    for (const m of this.markets) {
      const p = priceByAddr.get(m.market_addr);
      if (!p) continue;
      out.push(this.toMarketInfo(m, p));
    }
    return out;
  }

  async getMarket(symbol: string): Promise<MarketInfo | undefined> {
    const m = this.cfg(symbol);
    if (!m) return undefined;
    const p = (await this.pricesByAddr()).get(m.market_addr);
    if (!p) return undefined;
    return this.toMarketInfo(m, p);
  }

  /** 15m/1h K 线（网格 scanner 用） */
  async getCandles(
    symbol: string,
    intervalSec = 900,
    limit = 96
  ): Promise<{ time: number; open: number; high: number; low: number; close: number; volume?: number }[]> {
    const m = this.cfg(symbol);
    if (!m) return [];
    const interval =
      intervalSec >= 3600 ? this.sdk.CandlestickInterval.OneHour : this.sdk.CandlestickInterval.FifteenMinutes;
    const end = Date.now();
    const start = end - limit * intervalSec * 1000;
    const raw = await this.read.candlesticks.getByName({
      marketName: m.market_name,
      interval,
      startTime: start,
      endTime: end,
    });
    return (raw ?? [])
      .map((c: { t: number; o: number; h: number; l: number; c: number; v?: number }) => ({
        time: c.t,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
      }))
      .filter((c) => Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
  }

  private toMarketInfo(
    m: MarketCfg,
    p: { mark_px: number; funding_rate_bps: number; is_funding_positive: boolean; funding_period_s?: number }
  ): MarketInfo {
    const signedFracPerPeriod = (p.funding_rate_bps / 10000) * (p.is_funding_positive ? 1 : -1);
    const period = p.funding_period_s && p.funding_period_s > 0 ? p.funding_period_s : 28800;
    const funding8h = signedFracPerPeriod * (28800 / period);
    return {
      symbol: baseSymbol(m.market_name),
      maxLeverage: m.max_leverage,
      fundingRate8h: funding8h,
      markPrice: p.mark_px,
      minOrderSize: m.min_size / 10 ** m.sz_decimals,
      lotSize: m.lot_size / 10 ** m.sz_decimals,
      tickSize: m.tick_size / 10 ** m.px_decimals,
    };
  }

  // ---- 账户 ----
  async getBalance(): Promise<Balance> {
    const o = await this.read.accountOverview.getByAddr({ subAddr: this.subaccount });
    return {
      equity: o.perp_equity_balance,
      available: o.usdc_cross_withdrawable_balance,
    };
  }

  async getAccountStats(): Promise<AccountStats> {
    const o = await this.read.accountOverview.getByAddr({
      subAddr: this.subaccount,
      volumeWindow: "30d",
      includePerformance: true,
    });
    let feesPaid = o.fee_income != null ? Math.abs(o.fee_income) : undefined;
    // Decibel 概览 API 常不返回 fee_income → 从近 30 日成交汇总
    if (feesPaid == null) {
      const since = Date.now() - 30 * 86400000;
      feesPaid = await this.sumFeesSince(since).catch(() => undefined);
    }
    return {
      equity: o.perp_equity_balance,
      available: o.usdc_cross_withdrawable_balance,
      unrealizedPnl: o.unrealized_pnl,
      realizedPnl: o.realized_pnl ?? undefined,
      feesPaid,
      volume: o.volume ?? undefined,
      statsWindow: "近30日",
    };
  }

  /** 从 userTradeHistory 汇总指定时间窗内手续费（概览 fee_income 缺失时的回退） */
  private async sumFeesSince(sinceMs: number): Promise<number> {
    const now = Date.now();
    const c = this.tradeStatsCache;
    if (c && c.sinceMs === sinceMs && now - c.ts < 60_000) return c.fees;

    let fees = 0;
    for (let offset = 0; offset < 10_000; offset += 100) {
      const page = await this.read.userTradeHistory.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page.items ?? [];
      if (!items.length) break;
      let olderThanWindow = false;
      for (const t of items) {
        if (t.transaction_unix_ms < sinceMs) {
          olderThanWindow = true;
          continue;
        }
        fees += Math.abs(t.fee_amount);
      }
      if (olderThanWindow || items.length < 100) break;
    }
    this.tradeStatsCache = { ts: now, sinceMs, fees };
    return fees;
  }

  /** 从成交历史汇总全账户统计 + 近期平仓（Extended 看板同款） */
  async getOfficialTradeStats(): Promise<{
    volume: number;
    fees: number;
    realizedPnl: number;
    tradeCount: number;
    recentClosed: {
      market: string;
      closedTime: number;
      realizedPnl: number;
      side: string;
      size: number;
      exitPrice: number;
      fees: number;
    }[];
  }> {
    if (this.officialStatsCache && Date.now() - this.officialStatsCache.ts < 120_000) {
      const c = this.officialStatsCache;
      return {
        volume: c.volume,
        fees: c.fees,
        realizedPnl: c.realizedPnl,
        tradeCount: c.tradeCount,
        recentClosed: c.recentClosed.map((x) => ({ ...x })),
      };
    }

    let volume = 0;
    let fees = 0;
    let realizedPnl = 0;
    let tradeCount = 0;
    const recentClosed: {
      market: string;
      closedTime: number;
      realizedPnl: number;
      side: string;
      size: number;
      exitPrice: number;
      fees: number;
    }[] = [];
    const isClose = (a: string) => a === "CloseLong" || a === "CloseShort";

    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await this.read.userTradeHistory.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page.items ?? [];
      if (!items.length) break;
      for (const t of items) {
        tradeCount++;
        const sym = this.addrToBase.get(t.market) ?? baseSymbol(String(t.market));
        const vol = Math.abs(t.size * t.price);
        const fee = Math.abs(t.fee_amount);
        const pnl = t.realized_pnl_amount + t.realized_funding_amount;
        volume += vol;
        fees += fee;
        realizedPnl += pnl;
        if (isClose(t.action)) {
          recentClosed.push({
            market: sym,
            closedTime: t.transaction_unix_ms,
            realizedPnl: Math.round(pnl * 100) / 100,
            side: t.action === "CloseLong" ? "long" : "short",
            size: Math.abs(t.size),
            exitPrice: t.price,
            fees: Math.round(fee * 100) / 100,
          });
        }
      }
      if (items.length < 100) break;
    }

    recentClosed.sort((a, b) => b.closedTime - a.closedTime);
    const trimmed = recentClosed.slice(0, 40);
    this.officialStatsCache = {
      ts: Date.now(),
      volume: Math.round(volume * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      tradeCount,
      recentClosed: trimmed,
    };
    return {
      volume: this.officialStatsCache.volume,
      fees: this.officialStatsCache.fees,
      realizedPnl: this.officialStatsCache.realizedPnl,
      tradeCount: this.officialStatsCache.tradeCount,
      recentClosed: trimmed,
    };
  }

  async getPositions(): Promise<Position[]> {
    const [raw, priceByAddr] = await Promise.all([
      this.read.userPositions.getByAddr({ subAddr: this.subaccount, limit: 50 }),
      this.pricesByAddr().catch(() => new Map<string, any>()),
    ]);
    if (!Array.isArray(raw)) return [];
    const out: Position[] = [];
    for (const pos of raw) {
      if (!pos.size) continue;
      const base = this.addrToBase.get(pos.market) ?? baseSymbol(pos.market);
      const side: Side = pos.size >= 0 ? "long" : "short";
      const absSize = Math.abs(pos.size);
      // 标记价：复用缓存的全市场价（避免逐仓位请求）
      const p = priceByAddr.get(pos.market);
      const mark = p?.mark_px ?? pos.entry_price;
      const dir = side === "long" ? 1 : -1;
      out.push({
        symbol: base,
        side,
        size: absSize,
        entryPrice: pos.entry_price,
        markPrice: mark,
        liqPrice: pos.estimated_liquidation_price,
        unrealizedPnl: (mark - pos.entry_price) * absSize * dir,
        fundingPaid: -pos.unrealized_funding,
      });
    }
    return out;
  }

  /**
   * 与官方 decibel-cli / 对冲 hedgeManager 一致：userLeverage = 杠杆倍数（5x → 5）。
   * API user_leverage 与官网订单标签通常直接对应该整数。
   */
  static leverageToChain(leverage: number): number {
    return Math.max(1, Math.min(255, Math.floor(leverage)));
  }

  static leverageFromChain(userLeverage: number): number {
    return Math.max(1, Math.min(255, Math.floor(userLeverage)));
  }

  async getRawMarketSettings(symbol: string): Promise<Record<string, unknown> | null> {
    const m = this.cfg(symbol);
    if (!m) return null;
    const raw = await this.read.userPositions.getByAddr({
      subAddr: this.subaccount,
      marketAddr: m.market_addr,
      includeDeleted: true,
      limit: 5,
    });
    if (!Array.isArray(raw) || !raw.length) return null;
    const row = raw.find((p) => p.market === m.market_addr) ?? raw[0];
    return row as unknown as Record<string, unknown>;
  }

  async getMarketLeverage(symbol: string): Promise<number | null> {
    const m = this.cfg(symbol);
    if (!m) return null;
    const raw = await this.read.userPositions.getByAddr({
      subAddr: this.subaccount,
      marketAddr: m.market_addr,
      includeDeleted: true,
      limit: 5,
    });
    if (!Array.isArray(raw) || !raw.length) return null;
    const row = raw.find((p) => p.market === m.market_addr) ?? raw[0];
    if (row?.user_leverage) return DecibelExchange.leverageFromChain(row.user_leverage);
    return null;
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const m = this.cfg(symbol);
    if (!m) return;
    const target = Math.max(1, Math.floor(leverage));
    const cur = await this.getMarketLeverage(symbol).catch(() => null);
    if (cur === target) {
      log.info(`[Decibel] ${symbol} 杠杆已是 ${target}x，跳过设置`);
      return;
    }
    const userLeverage = DecibelExchange.leverageToChain(target);
    try {
      await this.write.configureUserSettingsForMarket({
        marketAddr: m.market_addr,
        subaccountAddr: this.subaccount,
        isCross: true,
        userLeverage,
      });
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes("ECANNOT_MODIFY_SETTINGS_WHILE_HOLDING_POSITION")) {
        const onCur = await this.getMarketLeverage(symbol).catch(() => null);
        if (onCur === target) {
          log.info(`[Decibel] ${symbol} 有持仓，链上杠杆已是 ${target}x`);
          return;
        }
      }
      throw e;
    }
    await new Promise((r) => setTimeout(r, 2500));
    const row = await this.getRawMarketSettings(symbol);
    const onChain = row?.user_leverage != null ? Number(row.user_leverage) : null;
    if (onChain !== userLeverage) {
      throw new Error(
        `${symbol} 杠杆未生效: 期望 user_leverage=${userLeverage}(${target}x) 实际=${onChain ?? "无"}`
      );
    }
    log.info(`[Decibel] ${symbol} 杠杆 ${target}x 已确认 (user_leverage=${onChain})`);
  }

  // ---- 下单（市价 = 激进价 IOC）----
  async placeMarketOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const m = this.cfg(params.symbol);
    if (!m) return { ok: false, error: `unknown market ${params.symbol}` };
    const isBuy = params.side === "long";

    const before = await this.positionSize(params.symbol);

    const pr = await this.read.marketPrices.getByName({ marketName: m.market_name });
    const mark = pr[0]?.mark_px;
    if (!mark) return { ok: false, error: "无标记价" };

    const chainSize = Math.round(params.size * 10 ** m.sz_decimals);
    let feeRate = 0.00034; // taker

    // maker：先挂被动 post-only 限价，限时等成交；不成交则撤单回退吃单
    const allowTaker = params.takerFallback !== false;
    if (params.maker && !params.reduceOnly) {
      const passive = isBuy ? mark * 0.9995 : mark * 1.0005;
      const makerRes = await this.write
        .placeOrder({
          marketName: m.market_name,
          price: Math.round(passive * 10 ** m.px_decimals),
          size: chainSize,
          isBuy,
          timeInForce: this.sdk.TimeInForce.PostOnly,
          isReduceOnly: false,
          clientOrderId: params.clientId,
          subaccountAddr: this.subaccount,
          tickSize: m.tick_size,
        })
        .catch((e: any) => ({ success: false, error: e?.message } as any));
      if (makerRes.success) {
        const after = await this.waitForFill(params.symbol, before, 6000);
        const filled = Math.abs(after - before);
        if (filled > 0) {
          let nativeTpslPlaced: boolean | undefined;
          if (config.useNativeTpsl && (params.takeProfitTriggerPrice || params.stopLossTriggerPrice)) {
            nativeTpslPlaced = await this.tryPlaceTpsl(
              m,
              params.side,
              filled,
              params.takeProfitTriggerPrice,
              params.stopLossTriggerPrice
            );
          }
          return {
            ok: true,
            orderId: makerRes.orderId,
            filledSize: filled,
            avgPrice: mark,
            fee: filled * mark * 0.00011,
            nativeTpslPlaced,
          };
        }
        // 未成交 → 撤掉这张挂单，回退吃单
        if (makerRes.orderId) await this.write.cancelOrder({ orderId: makerRes.orderId, marketName: m.market_name, subaccountAddr: this.subaccount }).catch(() => {});
      }
      if (!allowTaker) {
        return { ok: false, error: "maker 未成交且禁止 taker 回退", filledSize: 0 };
      }
    }

    if (!allowTaker && params.maker) {
      return { ok: false, error: "仅 maker 模式未启用 taker 回退", filledSize: 0 };
    }

    // 激进价确保 IOC 立即成交（taker）
    const aggressive = isBuy ? mark * 1.01 : mark * 0.99;
    const res = await this.write.placeOrder({
      marketName: m.market_name,
      price: Math.round(aggressive * 10 ** m.px_decimals),
      size: chainSize,
      isBuy,
      timeInForce: this.sdk.TimeInForce.ImmediateOrCancel,
      isReduceOnly: !!params.reduceOnly,
      clientOrderId: params.clientId,
      subaccountAddr: this.subaccount,
      tickSize: m.tick_size,
    });

    if (!res.success) return { ok: false, error: res.error };

    // Aptos 链上索引常慢于 Extended；与 Extended taker 8s 对齐，避免假「未检测到成交」
    const after = await this.waitForFill(params.symbol, before, 10_000);
    const filled = Math.abs(after - before);

    if (!params.reduceOnly && filled <= 0) {
      return { ok: false, error: "未检测到成交", filledSize: 0 };
    }

    let nativeTpslPlaced: boolean | undefined;
    if (
      config.useNativeTpsl &&
      filled > 0 &&
      !params.reduceOnly &&
      (params.takeProfitTriggerPrice || params.stopLossTriggerPrice)
    ) {
      nativeTpslPlaced = await this.tryPlaceTpsl(
        m,
        params.side,
        filled,
        params.takeProfitTriggerPrice,
        params.stopLossTriggerPrice
      );
    }

    return {
      ok: true,
      orderId: res.orderId,
      filledSize: filled,
      avgPrice: mark,
      fee: filled * mark * feeRate,
      nativeTpslPlaced,
    };
  }

  /** PostOnly/GTC 限价单（网格挂单） */
  async placeLimitOrder(params: {
    symbol: string;
    side: Side;
    size: number;
    price: number;
    reduceOnly?: boolean;
    clientId?: string;
    postOnly?: boolean;
  }): Promise<OrderResult> {
    const m = this.cfg(params.symbol);
    if (!m) return { ok: false, error: `unknown market ${params.symbol}` };
    const chainSize = Math.round(params.size * 10 ** m.sz_decimals);
    if (chainSize <= 0) return { ok: false, error: "size too small" };
    const chainPrice = Math.round(params.price * 10 ** m.px_decimals);
    const res = await this.write
      .placeOrder({
        marketName: m.market_name,
        price: chainPrice,
        size: chainSize,
        isBuy: params.side === "long",
        timeInForce: params.postOnly !== false ? this.sdk.TimeInForce.PostOnly : this.sdk.TimeInForce.GoodTillCanceled,
        isReduceOnly: !!params.reduceOnly,
        clientOrderId: params.clientId,
        subaccountAddr: this.subaccount,
        tickSize: m.tick_size,
      })
      .catch((e: any) => ({ success: false, error: e?.message } as any));
    if (!res.success) return { ok: false, error: res.error ?? "placeOrder failed" };
    return { ok: true, orderId: res.orderId, filledSize: 0, avgPrice: params.price, fee: 0 };
  }

  async cancelOrderById(symbol: string, orderId: string): Promise<boolean> {
    const m = this.cfg(symbol);
    if (!m) return false;
    const res = await this.write
      .cancelOrder({ orderId, marketName: m.market_name, subaccountAddr: this.subaccount })
      .catch(() => ({ success: false }));
    return !!res.success;
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrderView[]> {
    const sym = symbol?.toUpperCase();
    const priceByAddr = await this.pricesByAddr().catch(() => new Map<string, any>());
    const out: OpenOrderView[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await this.read.userOpenOrders.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page.items ?? [];
      if (!items.length) break;
      for (const o of items) {
        if (o.is_tpsl) continue;
        const base = this.addrToBase.get(o.market) ?? baseSymbol(String(o.market));
        if (sym && base !== sym) continue;
        const m = this.cfg(base);
        if (!m || o.price == null) continue;
        const mark = priceByAddr.get(o.market)?.mark_px ?? 0;
        const px = this.parseApiPrice(o.price, m, mark);
        const sz = this.parseApiSize(Math.abs(o.remaining_size ?? o.orig_size ?? 0), m);
        if (sz <= 0 || px <= 0) continue;
        out.push({
          orderId: o.order_id,
          clientId: o.client_order_id ?? "",
          symbol: base,
          price: px,
          size: sz,
          isBuy: o.is_buy,
          reduceOnly: !!o.is_reduce_only,
        });
      }
      if (items.length < 100) break;
    }
    return out;
  }

  /** 撤销账户全部挂单（含进程崩溃后残留；symbol 可选仅清单标的） */
  async cancelAllOpenOrders(symbol?: string): Promise<number> {
    let cancelled = 0;
    for (let round = 0; round < 30; round++) {
      const orders = await this.getOpenOrders(symbol);
      if (!orders.length) break;
      for (const o of orders) {
        if (await this.cancelOrderById(o.symbol, o.orderId)) cancelled++;
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    return cancelled;
  }

  /** 给持仓挂原生 TP/SL（best-effort，失败不影响开仓主流程） */
  private async tryPlaceTpsl(
    m: MarketCfg,
    side: Side,
    size: number,
    tpTrigger?: number,
    slTrigger?: number
  ): Promise<boolean> {
    try {
      const isLong = side === "long";
      const chainSize = Math.round(size * 10 ** m.sz_decimals);
      const px = (p: number, buf: number) => Math.round(p * buf * 10 ** m.px_decimals);
      const tpLimit = tpTrigger ? (isLong ? px(tpTrigger, 0.999) : px(tpTrigger, 1.001)) : undefined;
      const slLimit = slTrigger ? (isLong ? px(slTrigger, 0.997) : px(slTrigger, 1.003)) : undefined;
      await this.write.placeTpSlOrderForPosition({
        marketAddr: m.market_addr,
        tpTriggerPrice: tpTrigger ? Math.round(tpTrigger * 10 ** m.px_decimals) : undefined,
        tpLimitPrice: tpLimit,
        tpSize: tpTrigger ? chainSize : undefined,
        slTriggerPrice: slTrigger ? Math.round(slTrigger * 10 ** m.px_decimals) : undefined,
        slLimitPrice: slLimit,
        slSize: slTrigger ? chainSize : undefined,
        subaccountAddr: this.subaccount,
        tickSize: m.tick_size,
      });
      log.info(
        `[Decibel] 已挂原生 TP/SL ${m.market_name}` +
          (tpTrigger ? ` TP@${tpTrigger.toPrecision(6)}` : "") +
          (slTrigger ? ` SL@${slTrigger.toPrecision(6)}` : "")
      );
      return true;
    } catch (e: any) {
      log.warn(`[Decibel] 挂原生 TP/SL 失败(忽略): ${e?.message}`);
      return false;
    }
  }

  private async positionSize(symbol: string): Promise<number> {
    const ps = await this.getPositions();
    const p = ps.find((x) => x.symbol === symbol.toUpperCase());
    if (!p) return 0;
    return p.side === "long" ? p.size : -p.size;
  }

  private async waitForFill(symbol: string, before: number, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let last = before;
    while (Date.now() < deadline) {
      const cur = await this.positionSize(symbol);
      last = cur;
      if (Math.abs(cur - before) > 0) return cur;
      await new Promise((r) => setTimeout(r, 400));
    }
    return last;
  }

  async closePosition(symbol: string): Promise<OrderResult> {
    const ps = await this.getPositions();
    const p = ps.find((x) => x.symbol === symbol.toUpperCase());
    if (!p) return { ok: false, error: "NO_POSITION_SEEN", filledSize: 0 };
    return this.placeMarketOrder({
      symbol,
      side: p.side === "long" ? "short" : "long",
      size: p.size,
      reduceOnly: true,
    });
  }

  /** 分页拉取全部成交（交易所账本） */
  async fetchAllTrades(): Promise<NormalizedTrade[]> {
    const out: NormalizedTrade[] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const page = await this.read.userTradeHistory.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page.items ?? [];
      if (!items.length) break;
      for (const t of items) {
        const sym = this.addrToBase.get(t.market) ?? baseSymbol(String(t.market));
        out.push({
          ts: t.transaction_unix_ms,
          symbol: sym,
          fee: Math.abs(t.fee_amount),
          realizedPnl: t.realized_pnl_amount + t.realized_funding_amount,
          volume: Math.abs(t.size * t.price),
        });
      }
      if (items.length < 100) break;
    }
    return out;
  }

  /** 从 userTradeHistory 按 client_order_id / 原生平仓成交汇总本笔对冲盈亏 */
  async fetchHedgeTradeSettlement(hedge: HedgeSettlementQuery): Promise<HedgeTradeSettlement | null> {
    const sym = hedge.symbol.toUpperCase();
    const t0 = hedge.openedAt - 15_000;
    const t1 = (hedge.closedAt ?? Date.now()) + 180_000;
    const prefix = hedge.id;
    const isClose = (a: string) => a === "CloseLong" || a === "CloseShort";
    const isKa = (cid: string) => cid.startsWith("ka-");

    const allItems: Awaited<ReturnType<DecibelReadDex["userTradeHistory"]["getByAddr"]>>["items"] = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await this.read.userTradeHistory.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page.items ?? [];
      if (!items.length) break;
      allItems.push(...items);
      if (items.length < 100) break;
    }

    let realizedPnl = 0;
    let fees = 0;
    let volume = 0;
    let tradeCount = 0;
    for (const t of allItems) {
      const ts = t.transaction_unix_ms;
      if (ts < t0 || ts > t1) continue;
      const mkt = this.addrToBase.get(t.market) ?? baseSymbol(String(t.market));
      if (mkt !== sym) continue;
      const cid = t.client_order_id ?? "";
      if (isKa(cid)) continue;
      const ours = cid.startsWith(prefix);
      // 原生 TP/SL 平仓无 client_order_id：整笔持仓周期内的 Close 成交都算
      const nativeClose = !cid && isClose(t.action);
      if (!ours && !nativeClose) continue;
      realizedPnl += t.realized_pnl_amount + t.realized_funding_amount;
      fees += Math.abs(t.fee_amount);
      volume += Math.abs(t.size * t.price);
      tradeCount += 1;
    }
    if (tradeCount === 0) return null;
    return { realizedPnl, fees, volume, tradeCount };
  }

  /** Harvest 单腿平仓：按 client_order_id 前缀汇总 realized */
  async fetchClientFillsSince(
    symbol: string,
    sinceMs: number,
    clientIdPrefix: string
  ): Promise<HedgeTradeSettlement | null> {
    const sym = symbol.toUpperCase();
    const t0 = sinceMs - 5_000;
    const t1 = Date.now() + 120_000;
    let realizedPnl = 0;
    let fees = 0;
    let volume = 0;
    let tradeCount = 0;
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await this.read.userTradeHistory.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page.items ?? [];
      if (!items.length) break;
      for (const t of items) {
        const ts = t.transaction_unix_ms;
        if (ts < t0 || ts > t1) continue;
        const mkt = this.addrToBase.get(t.market) ?? baseSymbol(String(t.market));
        if (mkt !== sym) continue;
        const cid = t.client_order_id ?? "";
        if (!cid.startsWith(clientIdPrefix)) continue;
        realizedPnl += t.realized_pnl_amount + t.realized_funding_amount;
        fees += Math.abs(t.fee_amount);
        volume += Math.abs(t.size * t.price);
        tradeCount += 1;
      }
      if (items.length < 100) break;
    }
    if (tradeCount === 0) return null;
    return { realizedPnl, fees, volume, tradeCount };
  }
}

// 避免未使用告警（isPaper 保留给将来分支）
void isPaper;
