import dotenv from "dotenv";
dotenv.config();

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(name: string, def = ""): string {
  return process.env[name] ?? def;
}

/** GRID_AUTH_TOKEN 用于看板/API Bearer 认证 */
function resolveAuthToken(): string {
  return str("HEDGE_AUTH_TOKEN") || str("GRID_AUTH_TOKEN");
}

export type RunMode = "paper" | "testnet" | "mainnet";

export const config = {
  mode: (str("MODE", "paper") as RunMode),
  port: num("PORT", 8787),

  // 安全限额
  limits: {
    maxNotionalPerLeg: num("MAX_NOTIONAL_PER_LEG", 1000),
    maxTotalNotional: num("MAX_TOTAL_NOTIONAL", 3000),
    maxConcurrentHedges: num("MAX_CONCURRENT_HEDGES", 3),
    maxLeverage: num("MAX_LEVERAGE", 5),
    maxLossPerHedgeUsd: num("MAX_LOSS_PER_HEDGE_USD", 15),
    maxTotalDrawdownUsd: num("MAX_TOTAL_DRAWDOWN_USD", 80),
    maxHoldHours: num("MAX_HOLD_HOURS", 48),
    legImbalanceTolerance: num("LEG_IMBALANCE_TOLERANCE", 0.02),
    safetyFactor: num("SAFETY_FACTOR", 0.95),
    minNetFunding8h: num("MIN_NET_FUNDING_8H", 0.0002),
    // 单腿距爆仓的最小安全距离（小数）。任一腿 (|mark-liq|/mark) 低于此 → 去风险平仓。
    liqDistanceMin: num("LIQ_DISTANCE_MIN", 0.2),
    // 当日已实现手续费上限（USD），超过触发急停。0=关闭。
    maxDailyFeeUsd: num("MAX_DAILY_FEE_USD", 0),
    // 单笔对冲允许的最大“有效杠杆”=名义/该侧余额。超过则按余额收缩名义（防爆仓硬上限）。
    maxEffectiveLeverage: num("MAX_EFFECTIVE_LEVERAGE", 2),
  },

  decibel: {
    apiKey: str("DECIBEL_API_KEY"),
    privateKey: str("DECIBEL_ACCOUNT_PRIVATE_KEY"),
    subaccount: str("DECIBEL_SUBACCOUNT"),
    gasStationApiKey: str("DECIBEL_GAS_STATION_API_KEY"),
  },
  extended: {
    apiKey: str("EXTENDED_API_KEY"),
    starkPrivateKey: str("EXTENDED_STARK_PRIVATE_KEY"),
    starkPublicKey: str("EXTENDED_STARK_PUBLIC_KEY"),
    vaultId: str("EXTENDED_VAULT_ID"),
  },
  hyperliquid: {
    privateKey: str("HYPERLIQUID_PRIVATE_KEY"),
    /** 可选：主账户地址（代理/子账户时与签名私钥不同） */
    walletAddress: str("HYPERLIQUID_WALLET_ADDRESS"),
    testnet: str("HYPERLIQUID_TESTNET", "false") === "true",
  },
  ondo: {
    keyId: str("ONDO_KEY_ID"),
    apiSecret: str("ONDO_API_SECRET"),
  },

  // 策略模式：hold=长持对冲 | churn=保证金TP/SL刷量 | harvest=单腿 harvest+补对冲
  strategyMode: (str("STRATEGY_MODE", "hold") as "hold" | "churn" | "harvest"),

  /** harvest 模式：盈利腿 ≥ 阈值单腿平仓；锚腿 ≤ -stickyMaxLossUsd 整对止损 */
  harvest: {
    profitUsd: num("HARVEST_PROFIT_USD", 6),
    stickyMaxLossUsd: num("HARVEST_STICKY_MAX_LOSS_USD", 20),
    /** ATR 阈值底线（USD）；与 profitUsd 取 max */
    profitUsdMin: num("HARVEST_PROFIT_USD_MIN", 4),
    /** 盈利阈值 = max(profitUsd, profitUsdMin, profitAtrMult × ATR% × 名义) */
    profitAtrMult: num("HARVEST_PROFIT_ATR_MULT", 0.6),
    /** 盈利/止损阈值 ±抖动比例（防女巫） */
    profitJitterPct: num("HARVEST_PROFIT_JITTER_PCT", 0.2),
    stickyJitterPct: num("HARVEST_STICKY_JITTER_PCT", 0.2),
    /** 单腿窗口锚腿最长持仓（小时），超时整对强平 */
    anchorMaxHoldHours: num("HARVEST_ANCHOR_MAX_HOLD_HOURS", 0),
    /** 同标的连续锚腿止损达此次数 → 暂停该标的 N 分钟 */
    stickyPauseAfter: num("HARVEST_STICKY_PAUSE_AFTER", 2),
    stickyPauseMin: num("HARVEST_STICKY_PAUSE_MIN", 30),
    rehedgeTimeoutSec: num("HARVEST_REHEDGE_TIMEOUT_SEC", 45),
    cooldownSec: num("HARVEST_COOLDOWN_SEC", 90),
    minHoldSec: num("HARVEST_MIN_HOLD_SEC", 45),
    /** Decibel 链上：两腿不一致时最长等待秒数，超时即回滚 */
    chainTimeoutSec: num("HARVEST_CHAIN_TIMEOUT_SEC", 30),
  },

  /** 美股永续仅 RTH 开新仓（9:30–16:00 ET）；币股 24h 请保持 false */
  usRthOnly: str("US_RTH_ONLY", "false") === "true",
  /** 资金费结算前后暂停开新仓（UTC 整点 ±N 分钟） */
  fundingSettlePauseMin: num("FUNDING_SETTLE_PAUSE_MIN", 5),
  /** 自动开仓随机延迟（秒） */
  autoOpenDelayMinSec: num("AUTO_OPEN_DELAY_MIN_SEC", 30),
  autoOpenDelayMaxSec: num("AUTO_OPEN_DELAY_MAX_SEC", 180),
  /** 两次自动开仓最小间隔（分钟） */
  autoOpenMinIntervalMin: num("AUTO_OPEN_MIN_INTERVAL_MIN", 0),
  /** 持仓期两所 mark 偏离超此比例 → 暂停该标的开新仓（小数 0.002=0.2%） */
  markBasisPausePct: num("MARK_BASIS_PAUSE_PCT", 0.002),

  // hold 模式：当持仓方向的净资金费跌破此值(8h,小数)就平仓离场(funding 转为不利)。
  fundingExit8h: num("FUNDING_EXIT_8H", -0.0003),
  /** funding 离场需持续低于阈值的分钟数（滞回，防瞬时抖动来回开平）。0=立即 */
  fundingExitConfirmMin: num("FUNDING_EXIT_CONFIRM_MIN", 30),

  // smart-churn：net 浮盈超过本笔磨损（已付手续费+预估平仓费）则整对锁利。见 NET_PROFIT_LOCK_ABOVE_WEAR。
  netProfitLockAboveWear: str("NET_PROFIT_LOCK_ABOVE_WEAR", "true") === "true",
  /** 磨损之上的额外缓冲（USD），确保平仓后略有余量 */
  netProfitLockBufferUsd: num("NET_PROFIT_LOCK_BUFFER_USD", 0.8),
  /** 阈值内预留的滑点（USD） */
  netProfitLockSlippageUsd: num("NET_PROFIT_LOCK_SLIPPAGE_USD", 0.4),
  /** 触发前从组内Δ扣减的预估平仓滑点（名义×小数），对齐结算口径 */
  netProfitLockCloseSlippagePct: num("NET_PROFIT_LOCK_CLOSE_SLIPPAGE_PCT", 0.001),
  /** 可选固定锁利下限（USD）；0=仅按磨损。与 aboveWear 同时开时取 max(磨损+缓冲, 固定额) */
  netProfitLockUsd: num("NET_PROFIT_LOCK_USD", 0),
  /** true=用开仓后两所 equity 变化判断 net（比拼持仓字段更准）；false=用持仓 unrealized 求和 */
  netProfitLockUseEquity: str("NET_PROFIT_LOCK_USE_EQUITY", "true") === "true",
  /** net 锁利最短持仓（分钟），防刚开仓因价差抖动误触 */
  netProfitLockMinHoldMin: num("NET_PROFIT_LOCK_MIN_HOLD_MIN", 25),
  /** net≥此值可跳过最短持仓立即锁利；0=关闭（宁可少平） */
  netProfitLockEarlyUsd: num("NET_PROFIT_LOCK_EARLY_USD", 0),
  /** 扣 wear 后至少净赚 USD 才触发锁利（防「账面锁利、实收亏费」） */
  netProfitLockMinNetUsd: num("NET_PROFIT_LOCK_MIN_NET_USD", 0.5),

  // 每日 keep-alive：每个 UTC 日做一笔极小额中性活跃交易，维持 Decibel streak/consistency。
  dailyKeepalive: str("DAILY_KEEPALIVE", "false") === "true",
  keepaliveNotional: num("KEEPALIVE_NOTIONAL", 6),

  // hold 模式每日低频轮动：复用现有平仓/自动开仓路径，不做小额补量。
  dailyRotate: {
    enabled: str("DAILY_ROTATE_ENABLED", "false") === "true",
    minHoldHours: num("DAILY_ROTATE_MIN_HOURS", 20),
    /** UTC 小时，达到该小时后才允许当日轮动。-1=不限制小时。 */
    utcHour: num("DAILY_ROTATE_UTC_HOUR", -1),
  },

  // churn：止盈/止损按【保证金】百分比（自动在 min~max 间决策，非名义仓位%）
  tpMarginPctMin: num("TP_MARGIN_PCT_MIN", 12),
  tpMarginPctMax: num("TP_MARGIN_PCT_MAX", 22),
  slMarginPctMin: num("SL_MARGIN_PCT_MIN", 12),
  slMarginPctMax: num("SL_MARGIN_PCT_MAX", 22),

  // 自动杠杆范围（机器人在此区间决策，不写死单值）
  minLeverage: num("MIN_LEVERAGE", 3),
  maxLeverage: num("MAX_LEVERAGE_AUTO", 8),

  // 远端灾难止损（按价格%，与保证金TP/SL无关；0=关闭）。churn 下通常靠保证金TP/SL。
  stopLossPct: num("STOP_LOSS_PCT", 0),

  /** false=不在交易所挂原生 TP/SL，统一由机器人整对平仓，避免只平一边 */
  useNativeTpsl: str("USE_NATIVE_TPSL", "false") === "true",

  // 入场 maker 挂单（更省费；对冲开仓建议关闭，见 OPEN_TAKER_ONLY）
  makerEntry: str("MAKER_ENTRY", "false") === "true",

  // 对冲开仓强制吃单（稳定优先，避免 maker 腿差/假失败）
  openTakerOnly: str("OPEN_TAKER_ONLY", "true") === "true",

  /** taker_only | maker_taker（XEMM：低费率所 maker + 另一腿 taker） */
  entryMode: (str("ENTRY_MODE", "taker_only") as "taker_only" | "maker_taker"),

  /** HB min_funding_rate_profitability：>0 时要求扣费后净收益≥0 且净费率≥此值(8h 小数) */
  fundingMinProfitAfterFees: num("FUNDING_MIN_PROFIT_AFTER_FEES", 0),
  /** churn 典型持仓小时数，用于摊销开平手续费估算 APR */
  fundingProfitHoldHours: num("FUNDING_PROFIT_HOLD_HOURS", 2),

  // churn 一轮结束后自动重开冷却（分钟）；0=关，满足条件即重开
  roundCooldownMin: num("ROUND_COOLDOWN_MIN", 0),
  roundCooldownMaxMin: num("ROUND_COOLDOWN_MAX_MIN", 0),

  // 模拟作息安静窗：窗内不自动开新仓；刷量场景请关
  quietHoursEnabled: str("QUIET_HOURS_ENABLED", "false") === "true",
  /** false=不限制日轮次（刷量/真赚才平场景）；true=按 [min,max] 日抖动上限 */
  dailyRoundsCapEnabled: str("DAILY_ROUNDS_CAP_ENABLED", "false") === "true",
  dailyRoundsMin: num("DAILY_ROUNDS_MIN", 5),
  dailyRoundsMax: num("DAILY_ROUNDS_MAX", 25),

  // 基差择时：开仓方向基差边际 (空所价−多所价)/中价 低于该值(小数)则跳过（负=允许小幅劣势）
  basisEntryMinEdge: num("BASIS_ENTRY_MIN_EDGE", -0.0005),

  // 手动平仓/急停后，自动开仓暂停的分钟数（避免"手动平了又被自动开"）。
  manualPauseMin: num("MANUAL_PAUSE_MIN", 30),
  // 某 symbol 平仓/开仓失败后冷却（分钟）；0=关
  autoReopenCooldownMin: num("AUTO_REOPEN_COOLDOWN_MIN", 0),
  // 连续开仓失败达到该次数 → 触发急停（防烧费空转）。
  maxOpenFailures: num("MAX_OPEN_FAILURES", 3),

  // 交易对白名单（逗号分隔，大写）。只在这些两所同标的的优质加密永续上交易；空=不限制。
  symbolWhitelist: str(
    "SYMBOL_WHITELIST",
    "BTC,ETH,SOL,HYPE,SUI,AVAX,LINK,DOGE,XRP,LTC,BNB,ARB,OP,APT,NEAR,TIA,SEI"
  )
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean),

  // 每日【每边】目标交易量（USD）。>0 时每个 UTC 日刷到该量再持有（满足 Decibel 日要求+积累）。0=仅保活。
  dailyVolumeTarget: num("DAILY_VOLUME_TARGET", 0),

  // 换手周期（分钟）：churn 模式下，每笔对冲持有满该时长就强制平仓轮动。0=关闭。
  cycleHoldMinutes: num("CYCLE_HOLD_MINUTES", 0),

  // 已废弃：churn 改用保证金口径 TP/SL（见 TP_MARGIN_PCT_* / SL_MARGIN_PCT_*）
  tpslPct: num("TPSL_PCT", 0),

  // 监控循环间隔（毫秒）。调大可降低 API 请求频率（避免节点限流）。
  tickIntervalMs: num("TICK_INTERVAL_MS", 6000),
  // 看门狗：超过该时间没有 tick 视为异常
  watchdogStaleMs: 15000,

  /** Dec 单所 crypto 网格（与 Dec+Ondo 对冲 hard 隔离，symbol 勿进对冲白名单） */
  grid: {
    enabled: str("GRID_ENABLED", "false") === "true",
    symbol: str("GRID_SYMBOL", "SOL").trim().toUpperCase(),
    notionalUsd: num("GRID_NOTIONAL_USD", 400),
    leverage: num("GRID_LEVERAGE", 2),
    /** limit=Dec 挂 PostOnly 买卖单（偏盈利）；reactive=价格触发吃单（偏刷量） */
    mode: (str("GRID_MODE", "limit") as "limit" | "reactive"),
    /** 网格中心 ±rangePct 为有效区间，破区间暂停并平仓 */
    rangePct: num("GRID_RANGE_PCT", 0.025),
    levels: num("GRID_LEVELS", 5),
    /** 显式格距(小数)；0=按 range+levels 自动算 */
    stepPct: num("GRID_STEP_PCT", 0),
    /** 最大多头库存 = notional × 此比例，防单边加仓 */
    maxInventoryPct: num("GRID_MAX_INVENTORY_PCT", 0.6),
    /** 每边最多几张挂单 */
    maxOrdersPerSide: num("GRID_MAX_ORDERS_PER_SIDE", 3),
    /** 8h 资金费高于此(小数)时暂停挂买单（多头付费过高） */
    maxLongFunding8h: num("GRID_MAX_LONG_FUNDING_8H", 0.00015),
    /** 空仓且价偏离中心超过此比例时重定中心（limit 模式） */
    recenterWhenFlatPct: num("GRID_RECENTER_WHEN_FLAT_PCT", 0.012),
    /** 两次网格成交最小间隔（秒，reactive） */
    cooldownSec: num("GRID_COOLDOWN_SEC", 60),
    useMaker: str("GRID_USE_MAKER", "true") === "true",
    /** reactive 模式 maker 不成是否回退 taker */
    takerFallback: str("GRID_TAKER_FALLBACK", "false") === "true",
    /** 网格会话日亏上限（USD），触发暂停 */
    maxDailyLossUsd: num("GRID_MAX_DAILY_LOSS_USD", 10),
    /** 网格会话最大回撤（USD），触发暂停 */
    maxSessionDrawdownUsd: num("GRID_MAX_SESSION_DRAWDOWN_USD", 18),
  },

  /** extended-grid 独立进程 */
  gridFleet: {
    url: str("GRID_FLEET_URL", ""),
    token: str("GRID_FLEET_TOKEN") || resolveAuthToken(),
  },

  /** decibel-grid 独立进程 */
  decGridFleet: {
    url: str("DEC_GRID_FLEET_URL", ""),
    token: str("DEC_GRID_FLEET_TOKEN") || resolveAuthToken(),
  },

  ondoGridFleet: {
    url: str("ONDO_GRID_FLEET_URL", ""),
    token: str("ONDO_GRID_FLEET_TOKEN") || resolveAuthToken(),
  },

  /** risex-grid 独立进程 */
  risexGridFleet: {
    url: str("RISEX_GRID_FLEET_URL", ""),
    token: str("RISEX_GRID_FLEET_TOKEN") || resolveAuthToken(),
  },

  overviewPort: num("OVERVIEW_PORT", 0),

  /** Decibel GridBot 舰队（standalone=true 时由 :8083 进程运行，8787 仅代理） */
  decGrid: {
    standalone: str("DEC_GRID_STANDALONE", "false") === "true",
    enabled: str("DEC_GRID_ENABLED", "false") === "true",
    autostart: str("DEC_GRID_AUTOSTART", "false") === "true",
    slots: num("DEC_GRID_SLOTS", 3),
    candidates: str("DEC_GRID_CANDIDATES", "ETH,BTC,SOL"),
    preferSymbols: str("DEC_GRID_PREFER", "ETH,BTC,SOL"),
    leverage: num("DEC_GRID_LEVERAGE", 5),
    gridCount: num("DEC_GRID_GRID_COUNT", 22),
    rangeHalfPct: num("DEC_GRID_RANGE_HALF_PCT", 0.024),
  },

  /** Ondo GridBot 舰队（standalone=true 时由 :8084 进程运行，8787 仅代理） */
  ondoGrid: {
    standalone: str("ONDO_GRID_STANDALONE", "false") === "true",
    enabled: str("ONDO_GRID_ENABLED", "false") === "true",
    autostart: str("ONDO_GRID_AUTOSTART", "false") === "true",
    slots: num("ONDO_GRID_SLOTS", 1),
    candidates: str("ONDO_GRID_CANDIDATES", "NVDA,TSLA"),
    preferSymbols: str("ONDO_GRID_PREFER", "NVDA,TSLA"),
    /** RWA 专用：资金使用率、区间、杠杆等（见 venueFleetProfile.ts） */
    budgetUse: num("ONDO_GRID_BUDGET_USE", 0),
    rangeMinHalfPct: num("ONDO_GRID_RANGE_MIN_HALF", 0),
    rangeMaxHalfPct: num("ONDO_GRID_RANGE_MAX_HALF", 0),
    leverage: num("ONDO_GRID_LEVERAGE", 0),
    gridCount: num("ONDO_GRID_COUNT", 0),
    postOnlyTickOffset: num("ONDO_GRID_POST_ONLY_TICKS", 0),
    skipBand: num("ONDO_GRID_SKIP_BAND", 0),
  },

  /** Ondo :8084 策略模式：grid | trend | hybrid（趋势+刷量） */
  ondoStrategy: str("ONDO_STRATEGY", "grid"),

  /** Ondo 趋势 / 混合策略（:8084，ONDO_STRATEGY=trend|hybrid） */
  ondoTrend: {
    enabled: str("ONDO_TREND_ENABLED", "false") === "true",
    autostart: str("ONDO_TREND_AUTOSTART", "false") === "true",
    symbol: str("ONDO_TREND_SYMBOL", "NVDA"),
    leverage: num("ONDO_TREND_LEVERAGE", 5),
    budgetUse: num("ONDO_TREND_BUDGET_USE", 0.3),
    tpMarginPct: num("ONDO_TREND_TP_MARGIN_PCT", 15),
    slMarginPct: num("ONDO_TREND_SL_MARGIN_PCT", 10),
    minStrength: num("ONDO_TREND_MIN_STRENGTH", 0.4),
    pollSec: num("ONDO_TREND_POLL_SEC", 60),
    flattenOnStart: str("ONDO_TREND_FLATTEN_ON_START", "false") === "true",
    /** hybrid：正盘小仓 scalp 刷量 + 强趋势大仓 */
    hybrid: str("ONDO_TREND_HYBRID", "false") === "true" || str("ONDO_STRATEGY", "") === "hybrid",
    scalpBudgetUse: num("ONDO_TREND_SCALP_BUDGET_USE", 0.1),
    scalpTpMarginPct: num("ONDO_TREND_SCALP_TP_MARGIN_PCT", 9),
    scalpSlMarginPct: num("ONDO_TREND_SCALP_SL_MARGIN_PCT", 5),
    scalpCooldownSec: num("ONDO_TREND_SCALP_COOLDOWN_SEC", 900),
    scalpMaxHoldSec: num("ONDO_TREND_SCALP_MAX_HOLD_SEC", 2400),
    usRthOnly: str("ONDO_TREND_US_RTH_ONLY", "true") === "true",
    minAtrPct: num("ONDO_TREND_MIN_ATR_PCT", 0.1),
    maxDailyFeeUsd: num("ONDO_TREND_MAX_DAILY_FEE_USD", 7),
    /** 连续 Scalp 止损次数达到后暂停刷量（偏利润） */
    scalpMaxLossStreak: num("ONDO_TREND_SCALP_MAX_LOSS_STREAK", 2),
    scalpPauseAfterLossSec: num("ONDO_TREND_SCALP_PAUSE_AFTER_LOSS_SEC", 3600),
  },

  /** 启动时默认关闭自动开仓（切网格阶段用 AUTO_OPEN=false） */
  autoOpenDefault: str("AUTO_OPEN", "true") === "true",

  /** 看板/API 访问令牌；不配置则跳过鉴权（仅建议本机开发） */
  authToken: resolveAuthToken(),

  telegram: {
    enabled: str("TELEGRAM_ENABLED", "false") === "true",
    botToken: str("TELEGRAM_BOT_TOKEN"),
    /** 逗号分隔，仅这些 Chat ID 可收通知+远程控制 */
    chatIds: str("TELEGRAM_CHAT_IDS")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  },

  /** 8088 总看板 Telegram：每日 digest + 异常变动告警 */
  overviewTelegram: {
    enabled: str("OVERVIEW_TG_ENABLED", "false") === "true",
    /** 每日推送时刻（本地时区小时，逗号分隔） */
    digestHours: str("OVERVIEW_TG_DIGEST_HOURS", "8,14,22")
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((h) => h >= 0 && h <= 23),
    digestMinute: num("OVERVIEW_TG_DIGEST_MINUTE", 0),
    timezone: str("OVERVIEW_TG_TZ", "Asia/Shanghai"),
    checkSec: num("OVERVIEW_TG_CHECK_SEC", 60),
    equityDropPct: num("OVERVIEW_TG_EQUITY_DROP_PCT", 5),
    equityDropUsd: num("OVERVIEW_TG_EQUITY_DROP_USD", 80),
    venueEquityDropUsd: num("OVERVIEW_TG_VENUE_EQUITY_DROP_USD", 50),
    accountPnlSwingUsd: num("OVERVIEW_TG_PNL_SWING_USD", 40),
    positionDelta: num("OVERVIEW_TG_POSITION_DELTA", 4),
    alertCooldownMin: num("OVERVIEW_TG_ALERT_COOLDOWN_MIN", 30),
  },
} as const;

export const isPaper = config.mode === "paper";

/** 启动校验：返回 [警告列表, 有效配置摘要]，由 index 打印 */
export function validateConfig(): { warnings: string[]; summary: string } {
  const w: string[] = [];
  const L = config.limits;
  if (config.strategyMode === "hold" && (config.tpslPct > 0 || config.cycleHoldMinutes > 0)) {
    w.push("strategyMode=hold 但设置了 TPSL_PCT/CYCLE_HOLD_MINUTES（hold 模式会忽略它们）");
  }
  if (config.strategyMode === "harvest" && config.netProfitLockAboveWear) {
    w.push("strategyMode=harvest 时 net 整对锁利会被跳过（请设 NET_PROFIT_LOCK_ABOVE_WEAR=false）");
  }
  if (config.tpMarginPctMin > config.tpMarginPctMax) w.push("TP_MARGIN_PCT_MIN > MAX，已可能异常");
  if (config.slMarginPctMin > config.slMarginPctMax) w.push("SL_MARGIN_PCT_MIN > MAX，已可能异常");
  if (config.minLeverage > config.maxLeverage) w.push("MIN_LEVERAGE > MAX_LEVERAGE_AUTO");
  if (L.maxEffectiveLeverage > 5) w.push(`MAX_EFFECTIVE_LEVERAGE=${L.maxEffectiveLeverage} 偏高，单边爆仓风险上升`);
  if (L.maxLeverage > 10) w.push(`MAX_LEVERAGE=${L.maxLeverage} 偏高`);
  if (config.symbolWhitelist.length === 0) w.push("SYMBOL_WHITELIST 为空：将允许所有两所共有市场（含 RWA/股票，风险更高）");
  if (config.mode !== "paper" && !config.decibel.gasStationApiKey) w.push("未配置 Gas Station，Decibel 下单需 API 钱包持有 APT 付 gas");
  if (config.mode !== "paper" && (!config.ondo.keyId || !config.ondo.apiSecret))
    w.push("未配置 ONDO_KEY_ID/ONDO_API_SECRET，Ondo 腿不可用（需 Decibel+Ondo）");
  if (config.entryMode === "maker_taker" && config.openTakerOnly)
    w.push("ENTRY_MODE=maker_taker 但 OPEN_TAKER_ONLY=true，实际仍全 taker");
  if (config.fundingMinProfitAfterFees > 0 && config.fundingMinProfitAfterFees < L.minNetFunding8h)
    w.push("FUNDING_MIN_PROFIT_AFTER_FEES < MIN_NET_FUNDING_8H，入场门槛以较大者为准");
  if (config.dailyVolumeTarget > 0 && L.maxDailyFeeUsd > 0) {
    const estFee = config.dailyVolumeTarget * 2 * 0.0006; // 双边、约 0.06%
    if (estFee > L.maxDailyFeeUsd) w.push(`每日目标量预计手续费≈$${estFee.toFixed(1)} 可能触发当日费用熔断($${L.maxDailyFeeUsd})`);
  }
  if (config.grid.enabled) {
    const gs = config.grid.symbol;
    if (config.symbolWhitelist.some((x) => x === gs))
      w.push(`GRID_SYMBOL=${gs} 与 SYMBOL_WHITELIST 重叠：对冲可能误开同标的，请从白名单移除`);
    if (config.grid.notionalUsd > L.maxNotionalPerLeg * 0.5)
      w.push(`GRID_NOTIONAL_USD=${config.grid.notionalUsd} 相对对冲单边名义偏大，注意总敞口`);
  }
  const summary = [
    `模式=${config.mode} 策略=${config.strategyMode}`,
    `单边≤$${L.maxNotionalPerLeg} 合计≤$${L.maxTotalNotional} 杠杆≤${L.maxLeverage}x 有效杠杆≤${L.maxEffectiveLeverage}x 并发≤${L.maxConcurrentHedges}`,
    `TP/SL保证金=${config.tpMarginPctMin}-${config.tpMarginPctMax}%/${config.slMarginPctMin}-${config.slMarginPctMax}% 自动杠杆=${config.minLeverage}-${config.maxLeverage}x 轮次冷却=${config.roundCooldownMaxMin > 0 ? config.roundCooldownMin + "-" + config.roundCooldownMaxMin + "min" : "关"}`,
    `节奏: 安静窗=${config.quietHoursEnabled ? "开" : "关"} 日轮次上限=${config.dailyRoundsCapEnabled ? config.dailyRoundsMin + "-" + config.dailyRoundsMax : "关"} 基差边际≥${(config.basisEntryMinEdge * 100).toFixed(3)}%`,
    `liqDist≥${(L.liqDistanceMin * 100).toFixed(0)}% 单笔止损$${L.maxLossPerHedgeUsd} 回撤急停$${L.maxTotalDrawdownUsd} 日费上限$${L.maxDailyFeeUsd} 入场=${config.openTakerOnly ? "taker" : config.entryMode}`,
    `资金费扣费门槛=${config.fundingMinProfitAfterFees > 0 ? (config.fundingMinProfitAfterFees * 100).toFixed(4) + "%/8h" : "关"} 持仓假设=${config.fundingProfitHoldHours}h`,
    `最优资金费阈值≥${(L.minNetFunding8h * 100).toFixed(4)}% 资金费离场<${(config.fundingExit8h * 100).toFixed(4)}% net锁利≥磨损+${config.netProfitLockBufferUsd}+${config.netProfitLockSlippageUsd}U 扣滑点${(config.netProfitLockCloseSlippagePct * 100).toFixed(2)}%≥${config.netProfitLockMinHoldMin}min 早锁=${config.netProfitLockEarlyUsd > 0 ? "$" + config.netProfitLockEarlyUsd : "关"}`,
    `每日目标量=${config.dailyVolumeTarget > 0 ? "$" + config.dailyVolumeTarget + "/边" : "仅保活"} 手动暂停${config.manualPauseMin}min 重开冷却=${config.autoReopenCooldownMin > 0 ? config.autoReopenCooldownMin + "min" : "关"} 失败熔断${config.maxOpenFailures}次`,
    `白名单=${config.symbolWhitelist.length ? config.symbolWhitelist.join(",") : "(不限)"}`,
    config.grid.enabled
      ? `网格=开 ${config.grid.mode} ${config.grid.symbol} $${config.grid.notionalUsd} ${config.grid.leverage}x ±${(config.grid.rangePct * 100).toFixed(1)}% ${config.grid.levels}格 库存≤${(config.grid.maxInventoryPct * 100).toFixed(0)}%`
      : "旧gridEngine=关",
    config.decGrid.enabled
      ? config.decGrid.standalone
        ? `Dec网格=独立:${config.decGridFleet.url} ${config.decGrid.slots}槽 autostart=${config.decGrid.autostart}`
        : `Dec网格=${config.decGrid.slots}槽 ${config.decGrid.candidates} autostart=${config.decGrid.autostart}`
      : "Dec网格=关",
    config.ondoGrid.enabled
      ? config.ondoGrid.standalone
        ? `Ondo网格=独立:${config.ondoGridFleet.url} ${config.ondoGrid.slots}槽 autostart=${config.ondoGrid.autostart}`
        : `Ondo网格=${config.ondoGrid.slots}槽 ${config.ondoGrid.candidates} autostart=${config.ondoGrid.autostart}`
      : "Ondo网格=关",
    `Extended聚合=${config.gridFleet.url}`,
    config.strategyMode === "harvest"
      ? `harvest 盈利≥$${config.harvest.profitUsd}(ATR×${config.harvest.profitAtrMult} ±${(config.harvest.profitJitterPct * 100).toFixed(0)}%) 锚止损≤$${config.harvest.stickyMaxLossUsd} 锚最长${config.harvest.anchorMaxHoldHours}h 连续止损暂停${config.harvest.stickyPauseAfter}次 开仓间隔≥${config.autoOpenMinIntervalMin}min`
      : "",
  ].filter(Boolean).join("\n  ");
  return { warnings: w, summary };
}
