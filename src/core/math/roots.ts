/**
 * Bracketed 1-D root finding (L0). Illinois variant of regula falsi: as robust as bisection
 * (the root stays bracketed) but typically converges in ~10 evaluations, which matters when
 * each evaluation is a full linkage solve.
 */
export function illinois(
  f: (x: number) => number, a: number, b: number, fa = f(a), fb = f(b), tol = 1e-6, maxIter = 60,
): number {
  if (fa === 0) return a;
  if (fb === 0) return b;
  if ((fa < 0) === (fb < 0)) throw new Error('Root is not bracketed');
  let side = 0;
  for (let i = 0; i < maxIter; i++) {
    const c = (a * fb - b * fa) / (fb - fa);
    const fc = f(c);
    if (Math.abs(fc) === 0 || Math.abs(b - a) < tol) return c;
    if ((fc < 0) === (fb < 0)) {
      b = c; fb = fc;
      if (side === -1) fa /= 2;
      side = -1;
    } else {
      a = c; fa = fc;
      if (side === 1) fb /= 2;
      side = 1;
    }
    if (Math.abs(b - a) < tol) return (a + b) / 2;
  }
  return (a * fb - b * fa) / (fb - fa);
}
