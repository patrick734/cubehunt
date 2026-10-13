// CubeHunt mining engine: candidates for x^3 + y^3 + z^3 = k, checked exactly the way CubeHunt.sol checks a share.
// Plain JavaScript (BigInt), no dependencies, so the web worker and the contract tests run the same code.
//
// The search (an Elkies/Booker-style sieve, simplified): pick d = +-p for a prime p = 2 (mod 3). Cubing is then a
// bijection mod p, so k has exactly one cube root r0 mod p, and every z = r0 (mod p) makes p divide k - z^3. With
// d = x + y that is the first condition of a share; the contract then needs N = 4q - d^2 divisible by 3 (q = (k - z^3)/d)
// and Delta = N/3 a square-looking number (it survives the square tests mod 64, 7, ... 31). A candidate whose Delta
// is an exact square with d - r even is a SOLUTION: x = (d + r)/2, y = (d - r)/2.

const MASKS = [
  [64n, 0x202021202030213n],
  [7n, 0x17n],
  [11n, 0x23bn],
  [13n, 0x161bn],
  [17n, 0x1a317n],
  [19n, 0x30af3n],
  [23n, 0x5335fn],
  [29n, 0x13d122f3n],
  [31n, 0x121d47b7n],
];

export function survives(u) {
  for (const [m, mask] of MASKS) if (((mask >> (u % m)) & 1n) !== 1n) return false;
  return true;
}

export function isqrt(n) {
  if (n < 0n) throw new Error("negative");
  if (n < 2n) return n;
  // Newton from a power of two above the root
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

function modpow(b, e, m) {
  let r = 1n;
  b %= m;
  if (b < 0n) b += m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function isPrime(n) {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

/** Primes p = 2 (mod 3) in [lo, lo + count) roughly, as BigInt. */
export function primes2mod3(lo, want) {
  const out = [];
  for (let n = lo; out.length < want; n++) if (n % 3 === 2 && isPrime(n)) out.push(BigInt(n));
  return out;
}

/// The contract's _evaluate(), in JavaScript. Returns { reason, solution } with the same reason codes.
export function evaluate(k, z, d, r, zMin, zMax) {
  const K = BigInt(k);
  if (z === 0n || d === 0n) return { reason: 1, solution: false };
  const za = z < 0n ? -z : z;
  if (za < zMin || za >= zMax) return { reason: 2, solution: false };
  if ((z > 0n) === (d > 0n)) return { reason: 3, solution: false };
  if ((d < 0n ? -d : d) > za / 3n) return { reason: 4, solution: false };
  const m = K - z * z * z;
  if (m % d !== 0n) return { reason: 5, solution: false };
  const q = m / d;
  const nn = 4n * q - d * d;
  if (nn % 3n !== 0n) return { reason: 6, solution: false };
  const delta = nn / 3n;
  if (delta < 0n) return { reason: 7, solution: false };
  if (!survives(delta)) return { reason: 8, solution: false };
  if (r >= 1n << 127n) return { reason: 9, solution: false };
  if (r * r > delta || (r + 1n) * (r + 1n) <= delta) return { reason: 9, solution: false };
  return { reason: 0, solution: r * r === delta && (d - r) % 2n === 0n };
}

/// A random BigInt in [lo, hi).
function randBetween(lo, hi, rnd) {
  const span = hi - lo;
  const bits = span.toString(2).length + 16;
  let x = 0n;
  for (let i = 0; i < bits; i += 30) x = (x << 30n) | BigInt(Math.floor(rnd() * 2 ** 30));
  return lo + (x % span);
}

/**
 * Runs `tries` candidates for target k in band [zMin, zMax) and returns every one that passes all arithmetic checks
 * (a "survivor"; whether it is a share depends on the season hash, which the caller checks).
 * @param {{k:number, zMin:bigint, zMax:bigint, primes:bigint[], tries:number, rnd?:()=>number}} o
 */
export function search(o) {
  const rnd = o.rnd || Math.random;
  const K = BigInt(o.k);
  const found = [];
  let tried = 0;
  for (let i = 0; i < o.tries; i++) {
    const p = o.primes[Math.floor(rnd() * o.primes.length)];
    // the unique cube root of k mod p: k^((2p - 1)/3), since 3 * (2p - 1)/3 = 1 (mod p - 1)
    const r0 = modpow(K, (2n * p - 1n) / 3n, p);
    const negative = rnd() < 0.5;
    // z = r0 (mod p) with |z| in the band. For negative z we need -|z| = r0 (mod p), i.e. |z| = -r0 (mod p).
    const base = randBetween(o.zMin, o.zMax - p, rnd);
    const want = negative ? (p - r0) % p : r0;
    const za = base + ((want - (base % p) + p) % p);
    if (za >= o.zMax) continue;
    const z = negative ? -za : za;
    const d = negative ? p : -p;
    tried++;
    const m = K - z * z * z;
    const q = m / d; // exact: p | k - z^3
    const nn = 4n * q - d * d;
    if (nn % 3n !== 0n) continue;
    const delta = nn / 3n;
    if (delta < 0n || !survives(delta)) continue;
    const r = isqrt(delta);
    found.push({ k: o.k, z, d, r, solution: r * r === delta && (d - r) % 2n === 0n });
  }
  return { tried, found };
}

/** The share-hash test: the top `bits` bits of the hash are zero. `hash` is a 0x-hex string. */
export function meets(hash, bits) {
  if (bits === 0) return true;
  return BigInt(hash) >> BigInt(256 - bits) === 0n;
}
