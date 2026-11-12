// ADB 的 RSA 认证：纯 BigInt 实现。
//
// 为什么不用 crypto.subtle：无线模式下网页由手机通过 http://局域网地址 提供，那不是安全上下文，
// subtle 根本不存在；而且 ADB 要对**设备给的 20 字节令牌**做「当作 SHA-1 摘要」的 PKCS#1 v1.5
// 签名，subtle 只接受原文、自己再哈希一次，本来也签不出 ADB 要的值。BigInt 两种场合都能用。

const KEY_STORAGE = 'sunight.adbkey.v1';
const E = 65537n;
const SMALL_PRIMES = (() => {
  const out = [];
  for (let n = 3; out.length < 300; n += 2) {
    if (out.every((p) => n % p !== 0)) out.push(n);
  }
  return out.map(BigInt);
})();

function randomBigInt(bits) {
  const bytes = new Uint8Array(bits / 8);
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

function modInverse(a, m) {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('不可逆');
  return ((oldS % m) + m) % m;
}

function millerRabin(n, rounds) {
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) { d >>= 1n; s++; }
  for (let i = 0; i < rounds; i++) {
    const a = 2n + (randomBigInt(n.toString(2).length + 8 - (n.toString(2).length % 8)) % (n - 4n));
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let r = 1; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) { composite = false; break; }
    }
    if (composite) return false;
  }
  return true;
}

function generatePrime(bits) {
  for (;;) {
    // 最高两位置 1：两个素数相乘一定是满 2048 位。
    let p = randomBigInt(bits) | (3n << BigInt(bits - 2)) | 1n;
    if (SMALL_PRIMES.some((sp) => p % sp === 0n)) continue;
    if ((p - 1n) % E === 0n) continue;
    if (millerRabin(p, 24)) return p;
  }
}

function toBytesBE(v, length) {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function fromBytesBE(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function generateKey() {
  for (;;) {
    const p = generatePrime(1024);
    const q = generatePrime(1024);
    if (p === q) continue;
    const n = p * q;
    if (n.toString(2).length !== 2048) continue;
    const phi = (p - 1n) * (q - 1n);
    const d = modInverse(E, phi);
    return { n, d, p, q, dp: d % (p - 1n), dq: d % (q - 1n), qinv: modInverse(q, p) };
  }
}

function serialize(key) {
  return JSON.stringify(Object.fromEntries(Object.entries(key).map(([k, v]) => [k, v.toString(16)])));
}

function deserialize(text) {
  const o = JSON.parse(text);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt('0x' + v)]));
}

export class AdbKey {
  constructor(key) { this.key = key; }

  /** 读本机保存的密钥；没有就生成一把（约 1 秒），存进 localStorage。手机记住的就是这一把。 */
  static loadOrCreate(storage = globalThis.localStorage) {
    const saved = storage?.getItem(KEY_STORAGE);
    if (saved) {
      try { return new AdbKey(deserialize(saved)); } catch { /* 坏了就重建 */ }
    }
    const key = generateKey();
    storage?.setItem(KEY_STORAGE, serialize(key));
    return new AdbKey(key);
  }

  /** 对设备的 20 字节令牌签名：EMSA-PKCS1-v1_5，摘要算法标为 SHA-1，令牌本身当摘要。 */
  sign(token) {
    const digestInfo = [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14];
    const em = new Uint8Array(256);
    em[0] = 0x00; em[1] = 0x01;
    const tLen = digestInfo.length + token.length;
    em.fill(0xff, 2, 256 - tLen - 1);
    em[256 - tLen - 1] = 0x00;
    em.set(digestInfo, 256 - tLen);
    em.set(token, 256 - token.length);
    const m = fromBytesBE(em);
    const { p, q, dp, dq, qinv } = this.key;
    // CRT：比直接 m^d mod n 快约 3 倍。
    const m1 = modPow(m, dp, p);
    const m2 = modPow(m, dq, q);
    const h = (qinv * ((m1 - m2 + p) % p)) % p;
    return toBytesBE(m2 + h * q, 256);
  }

  /** Android 自定义的 RSAPublicKey 结构（小端），base64 后接一个名字。 */
  publicKey(name = 'sunight@web') {
    const { n } = this.key;
    const buf = new Uint8Array(4 + 4 + 256 + 256 + 4);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 64, true);
    const two32 = 1n << 32n;
    const n0inv = (two32 - modInverse(n % two32, two32)) % two32;
    view.setUint32(4, Number(n0inv), true);
    buf.set(toBytesBE(n, 256).reverse(), 8);
    const rr = modPow(2n, 4096n, n);
    buf.set(toBytesBE(rr, 256).reverse(), 264);
    view.setUint32(520, Number(E), true);
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    return `${btoa(bin)} ${name}\0`;
  }
}
