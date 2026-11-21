/**
 * Numerical integration (L0).
 *
 * Contact-patch integrands behave like √(distance to the contact edge) at the ends of each
 * interval. A cosine change of variable, s = a + (b − a)(1 − cos θ)/2, cancels that square-root
 * behaviour so Gauss–Legendre converges quickly with no special cases.
 */

/** Gauss–Legendre nodes and weights on [−1, 1]. */
export function gaussLegendre(n: number): { x: number[]; w: number[] } {
  const x = new Array<number>(n);
  const w = new Array<number>(n);
  for (let i = 0; i < Math.ceil(n / 2); i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 0;
    for (let iter = 0; iter < 100; iter++) {
      let p0 = 1;
      let p1 = z;
      for (let k = 2; k <= n; k++) {
        const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k;
        p0 = p1; p1 = p2;
      }
      dp = (n * (z * p1 - p0)) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x[i] = -z; x[n - 1 - i] = z;
    w[i] = w[n - 1 - i] = 2 / ((1 - z * z) * dp * dp);
  }
  return { x, w };
}

const GL = gaussLegendre(24);

/**
 * ∫ₐᵇ f(s) ds for several integrands at once, using the cosine map + 24-point Gauss–Legendre.
 * `f` writes its integrand values into `out` (length `count`).
 */
export function integrateCosineMap(
  a: number, b: number, count: number, f: (s: number, out: number[]) => void,
): number[] {
  const sums = new Array<number>(count).fill(0);
  if (!(b > a)) return sums;
  const vals = new Array<number>(count).fill(0);
  const half = (b - a) / 2;
  for (let i = 0; i < GL.x.length; i++) {
    const theta = (Math.PI / 2) * (GL.x[i]! + 1); // θ ∈ [0, π]
    const s = a + half * (1 - Math.cos(theta));
    const jac = half * Math.sin(theta) * (Math.PI / 2) * GL.w[i]!;
    f(s, vals);
    for (let k = 0; k < count; k++) sums[k]! += vals[k]! * jac;
  }
  return sums;
}

/** Find the root of a continuous f on [a, b] where f(a)·f(b) ≤ 0 (bisection, to `tol`). */
export function bisect(f: (x: number) => number, a: number, b: number, tol = 1e-10, maxIter = 200): number {
  let fa = f(a);
  for (let i = 0; i < maxIter && b - a > tol; i++) {
    const m = 0.5 * (a + b);
    const fm = f(m);
    if (fm === 0) return m;
    if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m;
  }
  return 0.5 * (a + b);
}
