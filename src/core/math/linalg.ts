/**
 * Small dense linear algebra for the constraint solver (L0).
 */

export type Matrix = number[][];

export const zeros = (rows: number, cols: number): Matrix =>
  Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

/** Solve A·x = b with Gaussian elimination and partial pivoting. Returns null if singular. */
export function solveLinear(A: Matrix, b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-300) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const pr = M[col]!;
    for (let r = col + 1; r < n; r++) {
      const row = M[r]!;
      const f = row[col]! / pr[col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c]! -= f * pr[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = M[r]!;
    let s = row[n]!;
    for (let c = r + 1; c < n; c++) s -= row[c]! * x[c]!;
    x[r] = s / row[r]!;
  }
  return x;
}

export interface RankInfo {
  rank: number;
  /** Smallest / largest pivot magnitude among the first min(m,n) pivots (0 = singular). */
  pivotRatio: number;
}

/**
 * Numerical rank via Gaussian elimination with full pivoting.
 * Columns should be pre-scaled to comparable magnitude for a meaningful ratio.
 */
export function rank(A: Matrix, relTol = 1e-9): RankInfo {
  const m = A.length;
  const n = m > 0 ? A[0]!.length : 0;
  const M = A.map((row) => [...row]);
  const k = Math.min(m, n);
  let maxPivot = 0;
  let minPivot = Infinity;
  let r = 0;
  for (let step = 0; step < k; step++) {
    let pr = -1;
    let pc = -1;
    let best = 0;
    for (let i = step; i < m; i++) {
      for (let j = step; j < n; j++) {
        const v = Math.abs(M[i]![j]!);
        if (v > best) { best = v; pr = i; pc = j; }
      }
    }
    if (step === 0) maxPivot = best;
    if (best <= relTol * maxPivot || best === 0) { minPivot = 0; break; }
    minPivot = Math.min(minPivot, best);
    [M[step], M[pr]] = [M[pr]!, M[step]!];
    for (const row of M) [row[step], row[pc]] = [row[pc]!, row[step]!];
    const prow = M[step]!;
    for (let i = step + 1; i < m; i++) {
      const row = M[i]!;
      const f = row[step]! / prow[step]!;
      if (f === 0) continue;
      for (let j = step; j < n; j++) row[j]! -= f * prow[j]!;
    }
    r++;
  }
  return { rank: r, pivotRatio: maxPivot > 0 && Number.isFinite(minPivot) ? minPivot / maxPivot : 0 };
}

export const norm = (v: number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
