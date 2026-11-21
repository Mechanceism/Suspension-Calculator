/**
 * Prints camber and roll center vs. travel for the sample layouts.
 *
 *   npm run compare:layouts
 */
import { DoubleWishbone } from '../src/core/suspension/doubleWishbone';
import { characteristics, deg } from '../src/core/suspension/characteristics';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const travels = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50];
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '∞');

const results = SAMPLE_LAYOUTS.map((l) => {
  const corner = new DoubleWishbone(l.geometry);
  const states = corner.sweep(travels, (travel) => ({ travel }));
  const chars = states.map(characteristics);
  const [m1, p1] = corner.sweep([-1, 1], (travel) => ({ travel })).map(characteristics);
  const gain = (deg(p1!.camber) - deg(m1!.camber)) / 2;
  const bad = states.filter((s) => s.solve.status !== 'converged');
  return { l, chars, design: characteristics(corner.design()), gain, bad };
});

console.log('\n=== Static characteristics ===\n');
console.log('Layout | FVSA (mm) | RC height (mm) | Camber gain (deg/mm) | Label');
console.log('-------|-----------|----------------|----------------------|------');
for (const r of results) {
  console.log(
    `${r.l.id}      | ${f(r.design.fvsa, 0).padStart(9)} | ${f(r.design.rollCenterHeight ?? NaN, 1).padStart(14)} | ` +
    `${f(r.gain, 4).padStart(20)} | ${r.l.label}`,
  );
}

console.log('\n=== Camber (deg) vs. wheel travel (mm, + = bump) ===\n');
console.log(`Travel | ${results.map((r) => `   ${r.l.id}   `).join('| ')}`);
console.log(`-------|${results.map(() => '---------').join('|')}`);
travels.forEach((t, i) => {
  console.log(`${String(t).padStart(6)} | ${results.map((r) => f(deg(r.chars[i]!.camber), 3).padStart(7) + ' ').join('| ')}`);
});

console.log('\n=== Roll center height (mm above ground) vs. travel ===\n');
console.log(`Travel | ${results.map((r) => `   ${r.l.id}   `).join('| ')}`);
travels.forEach((t, i) => {
  console.log(`${String(t).padStart(6)} | ${results.map((r) => f(r.chars[i]!.rollCenterHeight ?? NaN, 1).padStart(7) + ' ').join('| ')}`);
});

const failures = results.flatMap((r) => r.bad.map((s) => `${r.l.id} @ ${s.inputs.travel} mm: ${s.solve.status}`));
console.log(failures.length ? `\nSolver issues:\n${failures.join('\n')}` : '\nAll solves converged.');
