import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cornerFrame, ease, lastCamera, placeFor, recallView, rememberView, sameFrame, viewHeight } from '../src/app/viewport/cameraMemory';

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

  it('eases smoothly from 0 to 1', () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0.5)).toBe(0.5);
    expect(ease(2)).toBe(1);
    expect(ease(0.1)).toBeLessThan(0.1);
  });
});
