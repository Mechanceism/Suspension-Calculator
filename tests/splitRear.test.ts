import { describe, expect, it } from 'vitest';
import { useApp, defaultDesign } from '../src/app/store';
import { separateRear } from '../src/app/testOptimize';

// Round 4 (F23): separating the rear design from the front's (for the offer after an optimize run).
describe('separating the front and rear designs', () => {
  it('the rear gets its own copy (or the one given) and the front ranges for its points', () => {
    const d = defaultDesign();
    const f = (v: number) => ({ text: String(v), value: v });
    useApp.setState({ ...d, vehicleOptimizer: { ...d.vehicleOptimizer, ranges: { 'FL.ucaFwd.y': { lo: f(250), hi: f(300) } } } });
    expect(useApp.getState().links.rearFromFront).toBe(true);
    separateRear();
    const s = useApp.getState();
    expect(s.links.rearFromFront).toBe(false);
    expect(s.corners.RL.geom).toEqual(s.corners.FL.geom);
    expect(s.vehicleOptimizer.ranges['RL.ucaFwd.y']).toEqual({ lo: f(250), hi: f(300) });
    // From another rear (e.g. a snapshot's).
    useApp.setState({ ...d });
    const other = { ...d.corners.FL, spring: { ...d.corners.FL.spring, springRate: f(99) } };
    separateRear(other);
    expect(useApp.getState().corners.RL.spring.springRate.value).toBe(99);
  });
});
