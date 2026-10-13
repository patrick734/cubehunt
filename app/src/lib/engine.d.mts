export type Candidate = { k: number; z: bigint; d: bigint; r: bigint; solution: boolean };
export function survives(u: bigint): boolean;
export function isqrt(n: bigint): bigint;
export function primes2mod3(lo: number, want: number): bigint[];
export function evaluate(k: number, z: bigint, d: bigint, r: bigint, zMin: bigint, zMax: bigint): { reason: number; solution: boolean };
export function search(o: { k: number; zMin: bigint; zMax: bigint; primes: bigint[]; tries: number; rnd?: () => number }): { tried: number; found: Candidate[] };
export function meets(hash: string, bits: number): boolean;
