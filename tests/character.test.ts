import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REFERENCES, ROW_KEYS, STYLES, outside, rowMatch, styleMatches, characterSummary, type RowKey,
} from '../src/core/vehicle/character';
import { characterValues, useCharacterRefs, setReference, resetReferences } from '../src/app/character';
import { defaultDesign, type DesignState } from '../src/app/store';

// F29 (round 5): the setup's character against typical ranges per kind of driving.
const mid = (style: (typeof STYLES)[number]) =>
  Object.fromEntries(ROW_KEYS.map((k) => { const r = DEFAULT_REFERENCES[style][k]!; return [k, (r[0] + r[1]) / 2]; })) as Record<RowKey, number>;

describe('setup character: matching', () => {
  it('a row: 100 % at the middle of the range, 50 % at its ends, 0 a range-width from the middle', () => {
    expect(outside(5, [0, 10])).toBe(0);
    expect(outside(15, [0, 10])).toBeCloseTo(0.5, 12);
    expect(outside(-20, [0, 10])).toBeCloseTo(2, 12);
    expect(rowMatch(5, [0, 10])).toBe(1);
    expect(rowMatch(10, [0, 10])).toBeCloseTo(0.5, 12);
    expect(rowMatch(0, [0, 10])).toBeCloseTo(0.5, 12);
    expect(rowMatch(12.5, [0, 10])).toBeCloseTo(0.25, 12);
    expect(rowMatch(-20, [0, 10])).toBe(0);
  });

  it('every kind has a range for every row, low ≤ high', () => {
    for (const st of STYLES) for (const k of ROW_KEYS) {
      const r = DEFAULT_REFERENCES[st][k];
      expect(r, `${st} ${k}`).toBeDefined();
      expect(r![0]).toBeLessThanOrEqual(r![1]);
    }
  });

  it('a car in the middle of one kind\'s ranges matches it fully, front, rear and car', () => {
    const m = styleMatches(mid('track'));
    const track = m.find((x) => x.style === 'track')!;
    expect(track).toMatchObject({ front: 1, rear: 1, car: 1, overall: 1, rows: ROW_KEYS.length });
    expect(Math.max(...m.filter((x) => x.style !== 'track').map((x) => x.overall!))).toBeLessThan(1);
    expect(characterSummary(m)).toMatch(/^Closest to autocross \/ track \(100 %\)/);
  });

  it('a car tuned half for rally, half for the track lands between them', () => {
    const t = mid('track'), o = mid('offroad');
    // Front and car rows from the track, rear rows from rally / off-road.
    const v = Object.fromEntries(ROW_KEYS.map((k) => [k, k.startsWith('rear.') ? o[k] : t[k]])) as Record<RowKey, number>;
    const m = styleMatches(v);
    const by = Object.fromEntries(m.map((x) => [x.style, x]));
    expect(by.track!.front).toBe(1);
    expect(by.offroad!.rear).toBe(1);
    const ranked = [...m].sort((a, b) => b.overall! - a.overall!).map((x) => x.style);
    expect(ranked.slice(0, 2).sort()).toEqual(['offroad', 'track']);
    // The summary names the best one and the next.
    expect(characterSummary(m)).toMatch(/autocross \/ track|rally \/ off-road/);
  });

  it('missing values leave their rows out (not steered: no caster or KPI)', () => {
    const v: Partial<Record<RowKey, number | null>> = { 'front.staticCamber': -2.5, 'front.caster': null };
    const m = styleMatches(v);
    expect(m.every((x) => x.rows === 1 && x.rear === null && x.car === null)).toBe(true);
  });
});

describe('setup character: the design\'s values', () => {
  it('the default car: every row worked out, in sensible ranges', () => {
    const v = characterValues(defaultDesign() as unknown as DesignState);
    for (const k of ROW_KEYS) {
      if (k.startsWith('rear.') && (k.endsWith('caster') || k.endsWith('kpi'))) continue;
      expect(v[k], k).not.toBeNull();
      expect(Number.isFinite(v[k]), k).toBe(true);
    }
    expect(v['front.caster']).toBeDefined();
    expect(v['rear.caster']).toBeUndefined(); // the rear isn't steered
    expect(v['front.rideFrequency']!).toBeGreaterThan(0.5);
    expect(v['front.rideFrequency']!).toBeLessThan(5);
    expect(v['front.rideHeight']!).toBeGreaterThan(20);
    expect(v['car.rollShare']!).toBeGreaterThan(20);
    expect(v['car.rollShare']!).toBeLessThan(80);
  });

  it('the reference ranges can be edited and put back', () => {
    setReference('track', 'front.caster', [6, 8]);
    expect(useCharacterRefs.getState().refs.track['front.caster']).toEqual([6, 8]);
    expect(useCharacterRefs.getState().refs.road['front.caster']).toEqual(DEFAULT_REFERENCES.road['front.caster']);
    resetReferences();
    expect(useCharacterRefs.getState().refs.track['front.caster']).toEqual(DEFAULT_REFERENCES.track['front.caster']);
  });
});
