// Stark crypto for Extended (extended.exchange, Starknet perpetuals), zero deps.
// Implements: Poseidon (Hades) hash, SNIP-12 (rev 1) order message hash, and
// deterministic Stark-curve ECDSA (RFC 6979, StarkWare variant).
//
// The construction is verified byte-for-byte against the official Extended
// python SDK test vectors (tests/signing/order_object/test_limit_order_object.py).
// `selfTest()` re-runs one official vector and must pass before live trading.
import { createHash, createHmac } from 'node:crypto';

// ---- field / curve constants ----
export const PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
export const EC_ORDER = 0x0800000000000010FFFFFFFFFFFFFFFFB781126DCAE7B2321E66A241ADC64D2Fn;
const ALPHA = 1n;
const EC_GEN = [
  0x1EF15C18599971B7BECED415A40F0C7DEACFD9B0D1819E03D723D8BC943CFCAn,
  0x5668060AA49730B7BE4801DF46EC62DE53ECD11ABE43A32873000C36E8DC1Fn,
];
const TWO_251 = 2n ** 251n;

// SNIP-12 type hashes (= starknet_keccak of the type strings; verified against
// the on-chain contract constants in starkware-libs/starknet-perpetual).
export const ORDER_TYPE_HASH = 0x36da8d51815527cabfaa9c982f564c80fa7429616739306036f1f9b608dd112n;
export const DOMAIN_TYPE_HASH = 0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210n;

// ---- poseidon (Hades permutation, starknet variant) ----
// Round constants: sha256("Hades" + i) mod PRIME (same as cairo-lang).
const N_ROUNDS = 91; // 8 full + 83 partial
const ARK = (() => {
  const out = [];
  for (let i = 0; i < N_ROUNDS; i++) {
    const row = [];
    for (let j = 0; j < 3; j++) {
      const h = createHash('sha256').update(`Hades${3 * i + j}`).digest('hex');
      row.push(BigInt('0x' + h) % PRIME);
    }
    out.push(row);
  }
  return out;
})();

function hades(s0, s1, s2) {
  for (let r = 0; r < N_ROUNDS; r++) {
    const a = ARK[r];
    s0 = (s0 + a[0]) % PRIME; s1 = (s1 + a[1]) % PRIME; s2 = (s2 + a[2]) % PRIME;
    if (r < 4 || r >= 87) { // full rounds
      s0 = (s0 * s0 % PRIME) * s0 % PRIME;
      s1 = (s1 * s1 % PRIME) * s1 % PRIME;
      s2 = (s2 * s2 % PRIME) * s2 % PRIME;
    } else {                // partial rounds
      s2 = (s2 * s2 % PRIME) * s2 % PRIME;
    }
    const t0 = (3n * s0 + s1 + s2) % PRIME;
    const t1 = (s0 - s1 + s2 + PRIME) % PRIME;
    const t2 = (s0 + s1 - 2n * s2 + 2n * PRIME) % PRIME;
    s0 = t0; s1 = t1; s2 = t2;
  }
  return [s0, s1, s2];
}

export function poseidonHashMany(values) {
  const v = values.map((x) => ((x % PRIME) + PRIME) % PRIME);
  v.push(1n);
  if (v.length % 2) v.push(0n);
  let s0 = 0n, s1 = 0n, s2 = 0n;
  for (let i = 0; i < v.length; i += 2) {
    [s0, s1, s2] = hades((s0 + v[i]) % PRIME, (s1 + v[i + 1]) % PRIME, s2);
  }
  return s0;
}

/** Cairo short string -> felt (ASCII big-endian). */
export function shortString(s) {
  let v = 0n;
  for (const ch of Buffer.from(s, 'ascii')) v = (v << 8n) + BigInt(ch);
  return v;
}

// ---- modular / EC helpers ----
function invMod(a, m) {
  let [old_r, r] = [((a % m) + m) % m, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('not invertible');
  return ((old_s % m) + m) % m;
}

function ecAdd(p1, p2) {
  if (p1 === null) return p2;
  if (p2 === null) return p1;
  let m;
  if (p1[0] === p2[0]) {
    if ((p1[1] + p2[1]) % PRIME === 0n) return null;
    m = (3n * p1[0] * p1[0] + ALPHA) % PRIME * invMod(2n * p1[1], PRIME) % PRIME;
  } else {
    m = (p1[1] - p2[1] + PRIME) % PRIME * invMod((p1[0] - p2[0] + PRIME) % PRIME, PRIME) % PRIME;
  }
  const x = ((m * m - p1[0] - p2[0]) % PRIME + PRIME) % PRIME;
  const y = ((m * ((p1[0] - x + PRIME) % PRIME) - p1[1]) % PRIME + PRIME) % PRIME;
  return [x, y];
}

function ecMult(k, pt) {
  let res = null;
  while (k > 0n) {
    if (k & 1n) res = ecAdd(res, pt);
    pt = ecAdd(pt, pt);
    k >>= 1n;
  }
  return res;
}

/** Public key (x coordinate) from a private key. */
export function publicKeyFromPrivate(priv) {
  return ecMult(priv, EC_GEN)[0];
}

// ---- RFC 6979 deterministic k (StarkWare variant) ----
function bigIntToBytes(x, len = null) {
  let hex = x.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let buf = Buffer.from(hex, 'hex');
  if (len != null) {
    if (buf.length > len) throw new Error('int too large');
    buf = Buffer.concat([Buffer.alloc(len - buf.length), buf]);
  }
  return buf;
}
function bytesToBigInt(b) { return b.length ? BigInt('0x' + b.toString('hex')) : 0n; }
function bitLength(x) { return x === 0n ? 0 : x.toString(2).length; }

function bits2int(b, qlen) {
  const x = bytesToBigInt(b);
  const blen = BigInt(b.length * 8);
  return blen > BigInt(qlen) ? x >> (blen - BigInt(qlen)) : x;
}

function generateKRfc6979(msgHash, priv, seed) {
  // StarkWare quirk: pad one-nibble-short hashes (consistency with elliptic.js).
  const nbits = bitLength(msgHash);
  if (nbits % 8 >= 1 && nbits % 8 <= 4 && nbits >= 248) msgHash *= 16n;

  const extra = seed == null ? Buffer.alloc(0) : bigIntToBytes(seed);
  const data = bigIntToBytes(msgHash); // minimal-length big-endian bytes
  const qlen = 252, rolen = 32;
  const int2octets = (x) => bigIntToBytes(x, rolen);
  const bits2octets = (b) => int2octets(bits2int(b, qlen) % EC_ORDER);

  let V = Buffer.alloc(32, 0x01);
  let K = Buffer.alloc(32, 0x00);
  const h = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();
  K = h(K, V, Buffer.from([0x00]), int2octets(priv), bits2octets(data), extra);
  V = h(K, V);
  K = h(K, V, Buffer.from([0x01]), int2octets(priv), bits2octets(data), extra);
  V = h(K, V);
  for (;;) {
    let T = Buffer.alloc(0);
    while (T.length < rolen) { V = h(K, V); T = Buffer.concat([T, V]); }
    const k = bits2int(T, qlen);
    if (k >= 1n && k < EC_ORDER) return k;
    K = h(K, V, Buffer.from([0x00]));
    V = h(K, V);
  }
}

/** Deterministic Stark-curve ECDSA. Returns { r, s } as BigInt. */
export function starkSign(msgHash, priv) {
  if (!(msgHash >= 0n && msgHash < TWO_251)) throw new Error('message hash not signable');
  let seed = null;
  for (;;) {
    const k = generateKRfc6979(msgHash, priv, seed);
    seed = seed == null ? 1n : seed + 1n;
    const r = ecMult(k, EC_GEN)[0];
    if (!(r >= 1n && r < TWO_251)) continue;
    const t = (msgHash + r * priv) % EC_ORDER;
    if (t === 0n) continue;
    const w = k * invMod(t, EC_ORDER) % EC_ORDER;
    if (!(w >= 1n && w < TWO_251)) continue;
    return { r, s: invMod(w, EC_ORDER) };
  }
}

// ---- SNIP-12 (rev 1) order message hash ----
/** Encode possibly-negative amount as a field element. */
function toFelt(v) { return ((v % PRIME) + PRIME) % PRIME; }

export function domainHash({ name, version, chainId, revision }) {
  return poseidonHashMany([
    DOMAIN_TYPE_HASH, shortString(name), shortString(version), shortString(chainId), BigInt(revision),
  ]);
}

/**
 * SNIP-12 message hash for the perpetuals `Order` struct.
 * Amounts are scaled integers (BigInt, signed: base/quote have opposite signs).
 */
export function orderMsgHash(o) {
  const structHash = poseidonHashMany([
    ORDER_TYPE_HASH,
    BigInt(o.positionId),
    o.baseAssetId,
    toFelt(o.baseAmount),
    o.quoteAssetId,
    toFelt(o.quoteAmount),
    o.feeAssetId,
    o.feeAmount,
    BigInt(o.expirationSec),
    BigInt(o.salt),
  ]);
  return poseidonHashMany([shortString('StarkNet Message'), domainHash(o.domain), o.publicKey, structHash]);
}

// ---- exact decimal-string arithmetic (BigInt) ----
/** "12.34" -> { i: 1234n, scale: 2 } */
export function parseDec(s) {
  const m = String(s).trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error('无法解析数字: ' + s);
  const frac = m[3] || '';
  return { i: BigInt((m[1] || '') + m[2] + frac), scale: frac.length };
}

/** floor/ceil division for positive operands. mode: 'down' | 'up' */
function divRound(num, den, mode) {
  const q = num / den;
  if (num % den === 0n) return q;
  return mode === 'up' ? q + 1n : q;
}

/**
 * Stark settlement amounts for an order, mirroring the official SDK exactly:
 *   synthetic = qty * synRes              (buy: round up,  sell: round down)
 *   collateral = qty * price * colRes     (same rounding; negated for buys)
 *   fee = feeRate * qty * price * colRes  (always round up)
 *   synthetic negated for sells.
 */
export function settlementAmounts({ qty, price, feeRate, synRes, colRes, isBuy }) {
  const q = parseDec(qty), p = parseDec(price), f = parseDec(feeRate);
  const mode = isBuy ? 'up' : 'down';
  const syn = divRound(q.i * BigInt(synRes), 10n ** BigInt(q.scale), mode);
  const col = divRound(q.i * p.i * BigInt(colRes), 10n ** BigInt(q.scale + p.scale), mode);
  const fee = divRound(f.i * q.i * p.i * BigInt(colRes), 10n ** BigInt(f.scale + q.scale + p.scale), 'up');
  return {
    syntheticAmount: isBuy ? syn : -syn,
    collateralAmount: isBuy ? -col : col,
    feeAmount: fee,
  };
}

/**
 * Align a float to a decimal step (e.g. price 61827.73 with step "0.1").
 * mode: 'nearest' | 'down'. Returns a clean decimal string.
 */
export function alignToStep(value, step, mode = 'nearest') {
  const st = parseDec(step);
  if (st.i <= 0n) throw new Error('step 必须为正');
  const scaled = value * Number(10n ** BigInt(st.scale));
  const units = mode === 'down' ? Math.floor(scaled / Number(st.i) + 1e-9) : Math.round(scaled / Number(st.i));
  const total = BigInt(units) * st.i; // scaled integer at st.scale decimals
  return formatScaled(total, st.scale);
}

function formatScaled(i, scale) {
  const neg = i < 0n; if (neg) i = -i;
  let s = i.toString().padStart(scale + 1, '0');
  let out = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
  out = out.replace(/\.?0+$/, '');
  if (out === '' || out === '-') out = '0';
  return (neg ? '-' : '') + out;
}

export function toHex(v) { return '0x' + v.toString(16); }

// ---- self test (official Extended python SDK vector) ----
/** Throws if the implementation doesn't reproduce the official SDK signature. */
export function selfTest() {
  const priv = 0x7a7ff6fd3cab02ccdcd4a572563f5976f8976899b03a39773795a3c486d4986n;
  const pub = 0x61c5e7e8339b7d56f197f54ea91b776776690e3232313de0f2ecbd0ef76f466n;
  const amounts = settlementAmounts({
    qty: '0.00100000', price: '43445.11680000', feeRate: '0.0005',
    synRes: 1000000, colRes: 1000000, isBuy: false,
  });
  if (amounts.syntheticAmount !== -1000n || amounts.collateralAmount !== 43445116n || amounts.feeAmount !== 21723n) {
    throw new Error('starkcrypto selfTest: amounts mismatch');
  }
  const h = orderMsgHash({
    positionId: 10002,
    baseAssetId: 0x4254432d3600000000000000000000n,
    baseAmount: amounts.syntheticAmount,
    quoteAssetId: 0x31857064564ed0ff978e687456963cba09c2c6985d8f9300a1de4962fafa054n,
    quoteAmount: amounts.collateralAmount,
    feeAssetId: 0x31857064564ed0ff978e687456963cba09c2c6985d8f9300a1de4962fafa054n,
    feeAmount: amounts.feeAmount,
    expirationSec: 1706836137,
    salt: 1473459052,
    publicKey: pub,
    domain: { name: 'Perpetuals', version: 'v0', chainId: 'SN_SEPOLIA', revision: 1 },
  });
  const expectedHash = 2969335148777495210033041829700798003994871688044444919524700744667647811801n;
  if (h !== expectedHash) throw new Error('starkcrypto selfTest: order hash mismatch');
  const { r, s } = starkSign(h, priv);
  if (r !== 0x604ef07147d4251385eaaa630e6a71db8f0a8c7cb33021c98698047db80edfan
    || s !== 0x6c707d9a06604d3f8ffd34378bf4fce7c0aaf50cba4cf37c3525c323106cda5n) {
    throw new Error('starkcrypto selfTest: signature mismatch');
  }
  return true;
}
