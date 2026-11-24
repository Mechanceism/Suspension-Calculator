import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { shimmyScan, shimmyKick, wornParams, type ShimmyParams } from '../src/core';
it('explore', () => {
  const out: string[] = [];
  const r2 = 1 / (0.065 ** 2); // knuckle rad per steering-wheel rad ≈ 1 / 15.4
  const base: ShimmyParams = { trail: 0.02, pneumaticTrail: 0.03, relaxation: 0.4, cornering: 120000, knuckleInertia: 0.8, wheelInertia: 0.04 * r2, stiffness: 30000, freePlay: 0, damper: 20, spinInertia: 1.0, radius: 0.32, hands: { stiffness: 20 * r2, damping: 2 * r2 } };
  const cases: [string, ShimmyParams][] = [['car', base], ['car hands off', { ...base, hands: undefined }], ['low trail', { ...base, trail: 0.0, pneumaticTrail: 0.01 }], ['soft steering', { ...base, stiffness: 3000 }], ['solid axle', { ...base, axle: { inertia: 30, stiffness: 2 * 250000 * 0.75 ** 2, damping: 2 * 3000 * 0.75 ** 2, height: 0.35 } }], ['solid axle soft, no damper', { ...base, stiffness: 6000, damper: 0, axle: { inertia: 30, stiffness: 2 * 250000 * 0.75 ** 2, damping: 2 * 1000 * 0.75 ** 2, height: 0.35 }, spinInertia: 3, radius: 0.45 }]];
  for (const [name, p] of cases) {
    const s = shimmyScan(p, 45);
    const w = shimmyScan(wornParams(p, { freePlay: 0.0175, stiffness: 0.7, damper: 0.5 }), 45);
    const at = s.onset ?? s.worstSpeed;
    const kA = shimmyKick(p, Math.min(45, at + 2)), kB = shimmyKick(p, Math.max(3, at - 3));
    out.push(`${name}: new minZ ${s.minZeta.toFixed(3)} @${s.worstSpeed.toFixed(1)} f ${s.points.find((q) => q.speed === s.worstSpeed)!.frequency.toFixed(1)}Hz onset ${s.onset?.toFixed(1)} | worn minZ ${w.minZeta.toFixed(3)} onset ${w.onset?.toFixed(1)} | kick +2 ${kA.shimmies} r${kA.ratio.toFixed(2)} | -3 ${kB.shimmies} r${kB.ratio.toFixed(2)}`);
  }
  writeFileSync('zz.txt', out.join('\n'));
});
