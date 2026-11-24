import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { between, cornerFrame, ease, lastCamera, placeFor, recallView, rememberView, sameFrame, sweepStep, SWEEP, viewHeight } from '../src/app/viewport/cameraMemory';
import { fadeIn, isLeaving, showView, slotRef, useViewFade } from '../src/app/viewport/viewFade';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('camera memory across views', () => {
  it('maps a corner view to and from the vehicle frame (mirrored right, rear shifted by the wheelbase)', () => {
    const rr = cornerFrame('RR', 1550);
    const p = rr.toVehicle(v(400, 200, 100));
    expect(p.toArray()).toEqual([-400, 200, 100 - 1550]);
    expect(rr.fromVehicle(p.clone()).toArray()).toEqual([400, 200, 100]);
    expect(cornerFrame('FL', 1550).toVehicle(v(1, 2, 3)).toArray()).toEqual([1, 2, 3]);
  });

  it('remembers each view and hands the last camera to the next view in its own frame', () => {
    rememberView('corner', { pos: v(3000, 1000, 2000), target: v(400, 160, 0), height: 1200 }, cornerFrame('FR', 1550).toVehicle);
    // The vehicle view (vehicle frame) starts where the FR corner camera was: mirrored to the right side.
    const last = lastCamera(sameFrame.fromVehicle)!;
    expect(last.pos.toArray()).toEqual([-3000, 1000, 2000]);
    expect(last.target.toArray()).toEqual([-400, 160, 0]);
    expect(last.height).toBe(1200);
    // Each view keeps its own pose (a copy: changing it doesn't change the memory).
    const c = recallView('corner')!;
    c.pos.x = 0;
    expect(recallView('corner')!.pos.x).toBe(3000);
    expect(recallView('never-shown')).toBeNull();
  });

  it('keeps a view in its own frame when given one (a chase camera in the car frame)', () => {
    rememberView('chase', { pos: v(10, 20, 30), target: v(0, 0, 0) }, (p) => p.add(v(1, 0, 0)), { pos: v(0, 2, -5), target: v(0, 0.5, 0) });
    expect(recallView('chase')!.pos.toArray()).toEqual([0, 2, -5]);
    expect(lastCamera(sameFrame.fromVehicle)!.pos.toArray()).toEqual([11, 20, 30]);
  });

  it('hands the scale over between orthographic and perspective cameras', () => {
    const persp = new THREE.PerspectiveCamera(30, 1.5, 1, 1e6);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1e6);
    ortho.zoom = 0.25;
    const target = v(0, 0, 0), pos = v(0, 3000, -4000); // 5 m away
    const h = viewHeight(ortho, pos, target, 600); // 600 px tall at zoom 0.25: 2400 mm
    expect(h).toBeCloseTo(2400, 6);
    // In perspective the same height needs d = h / (2 tan 15°), along the same direction.
    const p = placeFor({ pos, target, height: h }, persp, 600);
    expect(p.pos.length()).toBeCloseTo(2400 / (2 * Math.tan(Math.PI / 12)), 3);
    expect(p.pos.clone().normalize().toArray().map((x) => +x.toFixed(6))).toEqual([0, 0.6, -0.8]);
    expect(viewHeight(persp, p.pos, target, 600)).toBeCloseTo(2400, 6);
    // And back: the zoom that shows it, the camera kept clear of the scene.
    const o = placeFor({ pos: p.pos, target, height: 2400 }, ortho, 600, 50000);
    expect(o.zoom).toBeCloseTo(0.25, 9);
    expect(o.pos.length()).toBeCloseTo(50000, 3);
  });

  it('sweeps between two cameras round the target the shorter way, the scale eased on a log scale', () => {
    const f = { pos: v(1000, 0, 0), target: v(0, 0, 0), height: 1000 };
    const d = { pos: v(0, 0, 2000), target: v(0, 0, 100), height: 4000 };
    expect(between(f, d, 0).pos.distanceTo(f.pos)).toBeLessThan(1e-6);
    const end = between(f, d, 1);
    expect(end.pos.distanceTo(d.pos)).toBeLessThan(1e-6);
    expect(end.height).toBeCloseTo(4000, 6);
    const mid = between(f, d, 0.5);
    expect(mid.target.toArray()).toEqual([0, 0, 50]);
    expect(mid.height).toBeCloseTo(2000, 6); // the geometric mean
    // Halfway round (+X to +Z): along the diagonal, never through the target.
    const dir = mid.pos.clone().sub(mid.target);
    expect(dir.x).toBeGreaterThan(0);
    expect(dir.z).toBeGreaterThan(0);
    expect(Math.abs(dir.x - dir.z)).toBeLessThan(1e-6);
    // From +X to -Z and to +Z the other way round: each the shorter way (a quarter turn each).
    const back = between(f, { pos: v(0, 0, -1000), target: v(0, 0, 0) }, 0.5).pos;
    expect(back.z).toBeLessThan(0);
    // A frame's step: capped at 50 ms, so a stalled frame slows the sweep instead of jumping it.
    expect(sweepStep(1)).toBeCloseTo(0.05 / SWEEP, 12);
    expect(sweepStep(0.01)).toBeCloseTo(0.01 / SWEEP, 12);
  });

  it('mid-sweep, keeps where the view is heading but hands on where its camera is now', () => {
    const now = { pos: v(2000, 500, 0), target: v(0, 0, 0), height: 1500 };
    const heading = { pos: v(0, 500, 2000), target: v(0, 0, 0), height: 2500 };
    rememberView('sweeping', now, sameFrame.toVehicle, heading);
    expect(recallView('sweeping')!.pos.toArray()).toEqual([0, 500, 2000]);
    // The next view starts from the camera as it was drawn (so it turns from there, no jump).
    expect(lastCamera(sameFrame.fromVehicle)!.pos.toArray()).toEqual([2000, 500, 0]);
    expect(lastCamera(sameFrame.fromVehicle)!.height).toBe(1500);
  });

  it('eases smoothly from 0 to 1', () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0.5)).toBe(0.5);
    expect(ease(2)).toBe(1);
    expect(ease(0.1)).toBeLessThan(0.1);
  });
});

describe('views fading in with the camera sweep', () => {
  const el = () => ({ style: {} as Record<string, string> });
  it('shows the first view at once, then fades the next in over the last (drawn under it) and drops the last at the end', () => {
    const a = el(), b = el(), c = el();
    slotRef('A')(a as never); slotRef('B')(b as never); slotRef('C')(c as never);
    showView('A');
    expect(a.style.opacity).toBe('1');
    showView('B');
    expect(b.style.opacity).toBe('0');
    expect(isLeaving('A')).toBe(true);
    expect(Number(b.style.zIndex)).toBeGreaterThan(Number(a.style.zIndex));
    fadeIn('B', 0.5);
    expect(Number(b.style.opacity)).toBeCloseTo(0.5, 9);
    fadeIn('A', 1); // not the view shown: ignored
    expect(isLeaving('A')).toBe(true);
    // Changing again mid-fade: B stays (at how far it got), A stays opaque at the bottom, C fades in on top.
    showView('C');
    expect(useViewFade.getState().leaving).toEqual(['A', 'B']);
    expect(a.style.opacity).toBe('1');
    expect(Number(b.style.opacity)).toBeCloseTo(0.5, 9);
    expect(Number(c.style.zIndex)).toBeGreaterThan(Number(b.style.zIndex));
    fadeIn('C', 0.2);
    fadeIn('C', 0.1); // only ever up
    expect(Number(c.style.opacity)).toBeCloseTo(ease(0.2), 9);
    fadeIn('C', 1);
    expect(c.style.opacity).toBe('1');
    expect(useViewFade.getState().leaving).toEqual([]);
    expect(a.style.opacity).toBe('0');
    expect(b.style.opacity).toBe('0');
  });
});
