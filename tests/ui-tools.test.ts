import { describe, it, expect } from 'vitest';
import {
  vec3, sub, length, viewAngle, withDistance, withDelta, withViewAngle, alongLine,
  armMetrics, setArmFrontViewAngle, parseValue,
} from '../src/core';
import { conversionFor, convertText, toDisplay, fromDisplay, isPlainNumber, PRESETS } from '../src/app/units';
import { useApp, pickDesign } from '../src/app/store';
import { initHistory, undo, redo, useHistory } from '../src/app/history';

const a = vec3(200, 100, -120);
const b = vec3(540, 130, -100);

describe('set dimension', () => {
  it('distance: moves the chosen point along the line, the other stays', () => {
    const nb = withDistance(a, b, 400, 'b')!;
    expect(length(sub(nb, a))).toBeCloseTo(400, 9);
    // Same direction.
    const u0 = sub(b, a), u1 = sub(nb, a);
    expect(u1.x / u0.x).toBeCloseTo(u1.y / u0.y, 9);
    const na = withDistance(a, b, 300, 'a')!;
    expect(length(sub(b, na))).toBeCloseTo(300, 9);
  });

  it('ΔX/ΔY/ΔZ: sets one component of B − A', () => {
    const nb = withDelta(a, b, 1, 0, 'b');
    expect(nb.y).toBeCloseTo(a.y, 9);
    expect(nb.x).toBe(b.x);
    const na = withDelta(a, b, 0, 300, 'a');
    expect(b.x - na.x).toBeCloseTo(300, 9);
  });

  it('view angles: setting one reaches it and keeps the in-view length and the out-of-view coordinate', () => {
    for (const view of ['front', 'side', 'top', 'slope'] as const) {
      const nb = withViewAngle(a, b, view, 12.5, 'b');
      expect(viewAngle(a, nb, view)).toBeCloseTo(12.5, 9);
    }
    const f = withViewAngle(a, b, 'front', -5, 'b');
    expect(f.z).toBe(b.z);
    expect(Math.hypot(f.x - a.x, f.y - a.y)).toBeCloseTo(Math.hypot(b.x - a.x, b.y - a.y), 9);
    const s = withViewAngle(a, b, 'slope', 20, 'b');
    expect(length(sub(s, a))).toBeCloseTo(length(sub(b, a)), 9);
  });

  it('along a line: moves toward (+) or away (−) from the other joint', () => {
    const p = alongLine(a, b, 50)!;
    expect(length(sub(b, p))).toBeCloseTo(length(sub(b, a)) - 50, 9);
    const q = alongLine(a, b, -20)!;
    expect(length(sub(b, q))).toBeCloseTo(length(sub(b, a)) + 20, 9);
  });

  it('arm front-view angle: reached with the ball joint, length and pivot spacing kept', () => {
    const arm = { fwd: vec3(250, 283, 120), aft: vec3(250, 283, -120), out: vec3(520, 330, 0) };
    const m0 = armMetrics(arm);
    for (const target of [-8, 0, 15]) {
      const next = setArmFrontViewAngle(arm, (target * Math.PI) / 180);
      const m = armMetrics(next);
      expect((m.frontViewAngle * 180) / Math.PI).toBeCloseTo(target, 6);
      expect(next.out).toEqual(arm.out);
      expect(m.length).toBeCloseTo(m0.length, 6);
      expect(m.pivotSpacing).toBeCloseTo(m0.pivotSpacing, 6);
    }
  });
});

describe('display units', () => {
  const imp = PRESETS.imperial;
  it('converts simple and compound units', () => {
    expect(conversionFor('mm', imp).unit).toBe('in');
    expect(toDisplay(25.4, conversionFor('mm', imp))).toBeCloseTo(1, 12);
    expect(conversionFor('N/mm', imp).unit).toBe('lbf/in');
    expect(toDisplay(1, conversionFor('N/mm', imp))).toBeCloseTo(5.71015, 4);
    expect(conversionFor('°/mm', imp).unit).toBe('°/in');
    expect(toDisplay(0.01, conversionFor('°/mm', imp))).toBeCloseTo(0.254, 9);
    expect(toDisplay(100, conversionFor('kPa', imp))).toBeCloseTo(14.5038, 3);
    expect(toDisplay(20, conversionFor('°C', imp))).toBeCloseTo(68, 9);
    expect(fromDisplay(68, conversionFor('°C', imp))).toBeCloseTo(20, 9);
    expect(conversionFor('mm', PRESETS.metric).identity).toBe(true);
    expect(conversionFor('g', imp).identity).toBe(true); // acceleration g is not grams
  });

  it('re-formats readouts with comparable precision, and recognizes plain numbers', () => {
    expect(convertText('254.0', conversionFor('mm', imp))).toBe('10.00');
    expect(convertText('—', conversionFor('mm', imp))).toBe('—');
    expect(isPlainNumber('12.5')).toBe(true);
    expect(isPlainNumber('10 + 2')).toBe(true);
    expect(isPlainNumber('5in')).toBe(false);
  });

  it('typed yards and ounces parse', () => {
    expect(parseValue('1yd', 'length')).toEqual({ ok: true, value: 914.4 });
    const oz = parseValue('16oz', 'mass');
    expect(oz.ok && oz.value).toBeCloseTo(0.45359237, 9);
  });
});

describe('undo / redo', () => {
  it('undoes and redoes design edits; quick bursts merge into one step', async () => {
    initHistory();
    const s = useApp.getState();
    const x0 = s.geom.points.trInner[0].value;
    s.setPoint('trInner', 0, '210');
    s.setPoint('trInner', 0, '215'); // same burst
    expect(useApp.getState().geom.points.trInner[0].value).toBe(215);
    expect(useHistory.getState().canUndo).toBe(true);
    undo();
    expect(useApp.getState().geom.points.trInner[0].value).toBe(x0);
    redo();
    expect(useApp.getState().geom.points.trInner[0].value).toBe(215);
    // A later edit (after the burst window) is its own step.
    await new Promise((r) => setTimeout(r, 650));
    useApp.getState().setPoint('trInner', 1, '90');
    undo();
    expect(useApp.getState().geom.points.trInner[1].value).not.toBe(90);
    expect(useApp.getState().geom.points.trInner[0].value).toBe(215);
    expect(pickDesign(useApp.getState())).toBeTruthy();
  });
});
