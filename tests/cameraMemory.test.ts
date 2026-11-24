import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cornerFrame, ease, lastCamera, recallView, rememberView, sameFrame } from '../src/app/viewport/cameraMemory';

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
    rememberView('corner', { pos: v(3000, 1000, 2000), target: v(400, 160, 0), zoom: 0.7 }, cornerFrame('FR', 1550).toVehicle);
    // The vehicle view (vehicle frame) starts where the FR corner camera was: mirrored to the right side.
    const last = lastCamera(sameFrame.fromVehicle)!;
    expect(last.pos.toArray()).toEqual([-3000, 1000, 2000]);
    expect(last.target.toArray()).toEqual([-400, 160, 0]);
    expect(last.zoom).toBe(0.7);
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

  it('eases smoothly from 0 to 1', () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0.5)).toBe(0.5);
    expect(ease(2)).toBe(1);
    expect(ease(0.1)).toBeLessThan(0.1);
  });
});
