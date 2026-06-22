// Shared constants + the IExchange contract (documented for both adapters).
//
// IExchange (EventEmitter):
//   async init()
//   async getMarkets()                         -> Market[]
//   async getCandles(marketId, intervalSec, n) -> Candle[]
//   async getPrice(marketId)                   -> number
//   async setLeverage(marketId, x)
//   async placeLimitOrder(o)                   -> { orderId }
//   async cancelOrder(marketId, orderId)
//   async cancelAll(marketId)
//   getOpenOrders(marketId)                    -> Order[]
//   getPosition(marketId)                      -> Position | null
//   start() / stop()
//   events: 'price' ({marketId, price}), 'fill' (Fill), 'error' (Error)
//
// Market   { marketId, displayName, symbol, lastPrice, stepSize, stepPrice, maxLeverage, minOrderSize }
// Candle   { time, open, high, low, close, volume }
// Order    { orderId, marketId, side, price, sizeBase, reduceOnly, levelIndex, clientOrderId }
// Fill     { orderId, marketId, side, price, sizeBase, levelIndex, clientOrderId }
// Position { sizeBase(signed +long/-short), entryPrice, unrealizedPnl }

export const SIDE = { BUY: 0, SELL: 1 };
export const ORDER_TYPE = { MARKET: 0, LIMIT: 1 };
export const TIF = { GTC: 0, GTT: 1, FOK: 2, IOC: 3 };
