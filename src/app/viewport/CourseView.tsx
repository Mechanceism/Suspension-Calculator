/**
 * Tests: the Dynamic view (round 3, V2; docs/MATH.md § Tests, dynamic view): the course in 3D from the
 * segments (turns, bank, grade, the road's bumps / potholes / rough patches, the path and the line driven)
 * with the car driving along it from the playback frames. One timeline with the Static view (Playback.tsx).
 * Several runs can be shown at once (`ghosts`: other frame sets drawn as see-through cars), so the compare
 * window (R9) can race a snapshot on the same course.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { create } from 'zustand';
import { useApp, mergedCorners, rootOf } from '../store';
import { segmentSpec, type TestDesign } from '../tests';
import { course, courseRoadHeight, placeOnCourse, type CoursePoint } from '../../core/tests/course';
import type { PlaybackFrame } from '../../core/tests/run';
import type { VehicleModel } from '../useVehicle';
import { VehicleScene, GhostScene } from './VehicleView';
import { COLORS } from './Scene';
import { usePlayback } from '../panels/Playback';
import { Line } from './primitives';
import { between, ease, lastCamera, placeFor, recallView, rememberView, sweepStep, viewHeight } from './cameraMemory';
import { FadeRoot, fadeIn, isLeaving } from './viewFade';

export type CourseCamera = 'chase' | 'overhead' | 'free';
export type CourseFollow = 'vehicle' | 'track';
interface TestViewState {
  /** Static: the car in place; Dynamic: driving the course. */
  mode: 'static' | 'dynamic';
  camera: CourseCamera;
  /** Chase / overhead follow the car itself, or the point of the track's center line nearest it. */
  follow: CourseFollow;
  /** Road width as a share of the car's overall width (where a segment has no track width of its own). */
  widthFactor: number;
  /** This view's own projection (the other views share the app's): perspective by default. */
  projection: 'perspective' | 'orthographic';
}
const load = (): Partial<TestViewState> => { try { return JSON.parse(localStorage.getItem('susp.testView') ?? '{}') as Partial<TestViewState>; } catch { return {}; } };
export const useTestView = create<TestViewState>(() => ({ mode: 'static', camera: 'chase', follow: 'vehicle', widthFactor: 1.5, projection: 'perspective', ...load() }));
export function setTestView(patch: Partial<TestViewState>) {
  useTestView.setState(patch);
  try { localStorage.setItem('susp.testView', JSON.stringify(useTestView.getState())); } catch { /* private mode */ }
}

const SEV: Record<string, string> = { pass: '#5cdc6a', warn: '#ffb703', fail: '#ff5c5c' };
/** Course (m, top view x / y, height z) → scene (mm; X left, Y up, Z forward at heading 0). */
const toScene = (x: number, y: number, z: number) => new THREE.Vector3(y * 1000, z * 1000, x * 1000);

/**
 * Where a run is at time t on the course: between its frames. `onCenter`: the point of the track's center
 * line at the car's distance along (no offset from the line, no sideslip), for a camera that follows the track.
 */
export function poseAt(points: CoursePoint[], segStart: number[], frames: PlaybackFrame[], t: number, onCenter = false): { pos: THREE.Vector3; heading: number; grade: number; bank: number } | null {
  if (!frames.length || !points.length) return null;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (frames[m]!.t <= t) lo = m; else hi = m - 1; }
  const fa = frames[lo]!, fb = frames[Math.min(frames.length - 1, lo + 1)]!;
  const u = fb.t > fa.t ? Math.min(1, Math.max(0, (t - fa.t) / (fb.t - fa.t))) : 0;
  const strip = (f: PlaybackFrame) => (onCenter ? { ...f, handling: undefined } : f);
  const a = placeOnCourse(points, segStart, strip(fa)), b = placeOnCourse(points, segStart, strip(fb));
  const L = (p: number, q: number) => p + (q - p) * u;
  return { pos: toScene(L(a.x, b.x), L(a.y, b.y), L(a.z, b.z)), heading: L(a.heading, b.heading), grade: L(a.grade, b.grade), bank: L(a.bank, b.bank) };
}

/** The road: a ribbon across its width with the bank, grade and road heights; rough / bumpy parts shaded. */
function Road({ points, segs, halfWidth }: { points: CoursePoint[]; segs: ReturnType<typeof segmentSpec>[]; halfWidth: (seg: number) => number }) {
  const geo = useMemo(() => {
    const M = 9; // across
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const base = new THREE.Color('#3a4150'), rough = new THREE.Color('#4d4a3a'), up = new THREE.Color('#ffb703'), down = new THREE.Color('#4cc9f0');
    points.forEach((p, i) => {
      const w = halfWidth(p.segment);
      const sg = segs[p.segment];
      const isRough = !!sg?.road?.rough;
      for (let j = 0; j < M; j++) {
        const lat = -w + (2 * w * j) / (M - 1); // + = left
        const h = courseRoadHeight(segs, p, lat); // mm
        const zz = p.z - lat * Math.sin(p.bank); // + bank: the left side lower
        const v = toScene(p.x - lat * Math.sin(p.heading), p.y + lat * Math.cos(p.heading), zz);
        v.y += h;
        pos.push(v.x, v.y, v.z);
        const c = (isRough ? rough : base).clone();
        if (Math.abs(h) > 2) c.lerp(h > 0 ? up : down, Math.min(1, Math.abs(h) / 40));
        col.push(c.r, c.g, c.b);
        if (i > 0 && j > 0) {
          const a = (i - 1) * M + (j - 1), b = (i - 1) * M + j, c2 = i * M + (j - 1), d = i * M + j;
          idx.push(a, c2, b, b, c2, d);
        }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [points, segs, halfWidth]);
  return (
    <mesh geometry={geo} receiveShadow>
      <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.95} fog={false} />
    </mesh>
  );
}

type Pose = { pos: THREE.Vector3; heading: number; grade: number; bank: number };

/**
 * The ground: a plain dark plane just below the course's lowest point with a 5 m grid on it (ordinary
 * materials, drawn with the logarithmic depth buffer, so it doesn't fight the road). It fades into the
 * background with distance (fog, the road kept clear of it), scaled to the camera's height, so the grid
 * lines don't crowd into shimmering bands toward the horizon.
 */
function CourseGround({ center, low, span, bg }: { center: THREE.Vector3; low: number; span: number; bg: string }) {
  const scene = useThree((st) => st.scene);
  const fog = useMemo(() => new THREE.Fog(bg, 30000, 150000), [bg]);
  useEffect(() => { scene.fog = fog; return () => { scene.fog = null; }; }, [scene, fog]);
  useFrame(({ camera }) => {
    // Orthographic: no fade (no horizon for the lines to crowd into, and the camera stands far back).
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) { fog.near = 1e9; fog.far = 2e9; return; }
    // From a few camera heights away to six times that: a low chase camera sees the ground fade within
    // some 30 m (where its lines would crowd together), a high free camera sees the whole track's.
    fog.near = Math.max(5000, (camera.position.y - low) * 2.5);
    fog.far = fog.near * 6;
  });
  const side = Math.ceil((span * 3 + 100000) / 10000) * 10000;
  const cells = Math.min(400, Math.round(side / 5000));
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(side, cells, '#566075', COLORS.ground);
    const mats = Array.isArray(g.material) ? g.material : [g.material];
    for (const mt of mats) { mt.transparent = true; mt.opacity = 0.55; mt.depthWrite = false; }
    return g;
  }, [side, cells]);
  useEffect(() => () => { grid.geometry.dispose(); (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach((mt) => mt.dispose()); }, [grid]);
  return (
    <group position={[center.x, low - 150, center.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -5, 0]}>
        <planeGeometry args={[side, side]} />
        <meshBasicMaterial color="#1c2027" />
      </mesh>
      <primitive object={grid} />
    </group>
  );
}

/** The car placed on the course at the playback time (its own model, posed by the playback). */
function CarOnCourse({ model, poseNow }: { model: VehicleModel | null; poseNow: () => Pose | null }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const at = poseNow();
    if (!at || !group.current) return;
    group.current.position.copy(at.pos);
    group.current.rotation.set(-at.grade, at.heading, -at.bank, 'YXZ');
  });
  if (!model?.result) return null;
  return (
    <group ref={group}>
      {/* The car's own frame has the ground at groundY: lift it onto the road. */}
      <group position={[0, -model.groundY, 0]}>
        <VehicleScene model={model} arrows={[]} ground={false} />
      </group>
    </group>
  );
}

/** Another run on the same course, from its frames: its own car drawn see-through (Compare: the snapshot, posed by its own run). */
function GhostCar({ frames, points, segStart, model }: { frames: PlaybackFrame[]; points: CoursePoint[]; segStart: number[]; model?: VehicleModel | null }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const at = poseAt(points, segStart, frames, usePlayback.getState().t);
    if (!at || !group.current) return;
    group.current.position.copy(at.pos);
    group.current.rotation.set(-at.grade, at.heading, -at.bank, 'YXZ');
  });
  return (
    <group ref={group}>
      {model?.result && <group position={[0, -model.groundY, 0]}><GhostScene model={model} /></group>}
    </group>
  );
}

/** The car's frame on the course: vehicle frame (ground at groundY) → scene. */
function carMatrix(p: Pose, groundY: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  out.makeRotationFromEuler(new THREE.Euler(-p.grade, p.heading, -p.bank, 'YXZ')).setPosition(p.pos);
  return out.multiply(new THREE.Matrix4().makeTranslation(0, -groundY, 0));
}

/** A camera view: where it is, what it looks at, how much it shows there (visible height at the target, mm). */
type View = { pos: THREE.Vector3; target: THREE.Vector3; height: number };
const UP = new THREE.Vector3(0, 1, 0);
/** This view's slot in the view stack (viewFade.ts). */
const SLOT = 'testsDynamic';
/** The default views' scale is set as for a 45° perspective camera at their distance. */
const TAN_HALF_45 = Math.tan(Math.PI / 8);

/** Where the free camera's pivot is along the track (m from the start); kept while the page is open. */
let freeAt: number | null = null;

/**
 * Cameras. All three orbit around a point that carries them along and turns them with it (drag to look
 * round, scroll to zoom); clicking the active button again sweeps the camera back to its default.
 * - **Chase** (behind and above) and **overhead** (straight down) follow the car, or the point of the track's
 *   center line nearest it (steadier: the car's wander off the line and its sideslip don't swing the view).
 * - **Free** unlocks the camera from the car where it is: it then orbits a pivot on the track's center line
 *   (where the car was), and right-drag (or Shift + drag) slides that pivot along the track like grabbing
 *   the ground, so the view "scrolls" along the course, turning with it as chase does.
 * Perspective (by default) or orthographic: this view's own setting, apart from the other views'. Every change of camera sweeps
 * smoothly (orbiting round the target, not cutting through it, the scale eased); each camera remembers
 * where it was left; on opening, the camera starts where the last view's was around the car, at the same
 * scale (cameraMemory.ts), and sweeps from there. The car and the camera read the same pose each frame.
 */
function CourseCamera({ active, mode, follow, followPose, carPose, carDistance, trackAt, length, groundY, size, reach, resetKey }: {
  active: boolean; mode: CourseCamera; follow: CourseFollow; followPose: () => Pose | null; carPose: () => Pose | null;
  carDistance: () => number; trackAt: (d: number) => Pose | null; length: number; groundY: number; size: number;
  /** How far an orthographic camera stands back from what it looks at (clear of the whole course). */
  reach: number; resetKey: number;
}) {
  const cam = useThree((st) => st.camera);
  const gl = useThree((st) => st.gl);
  const vh = useThree((st) => st.size.height);
  const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
  const controls = useRef<{ target: THREE.Vector3; update: () => void; enabled: boolean } | null>(null);
  const prev = useRef<Pose | null>(null);
  const key = `testsDynamic:${mode}`;
  // What the camera goes round: the car (or the track by it), or the free pivot.
  const pivot = (): Pose | null => (mode === 'free' ? trackAt(freeAt ?? carDistance()) : followPose());
  // Views are kept in the pivot's own frame (turned with its heading).
  const toWorld = (p: Pose, v: THREE.Vector3) => v.clone().applyAxisAngle(UP, p.heading).add(p.pos);
  const toLocal = (p: Pose, v: THREE.Vector3) => v.clone().sub(p.pos).applyAxisAngle(UP, -p.heading);
  const local = (p: Pose, v: View): View => ({ pos: toLocal(p, v.pos), target: toLocal(p, v.target), height: v.height });
  const world = (p: Pose, v: View): View => ({ pos: toWorld(p, v.pos), target: toWorld(p, v.target), height: v.height });
  const view = (pos: THREE.Vector3, target: THREE.Vector3): View => ({ pos, target, height: 2 * pos.distanceTo(target) * TAN_HALF_45 });
  const home = (): View => (mode === 'chase'
    ? view(new THREE.Vector3(0, size * 0.9, -size * 2.2), new THREE.Vector3(0, size * 0.25, 0))
    : mode === 'overhead'
      ? view(new THREE.Vector3(0, size * 2.4, -size * 0.02), new THREE.Vector3())
      : view(new THREE.Vector3(size * 2.2, size * 2.4, -size * 3.2), new THREE.Vector3()));
  // The camera now, and showing a view with this camera (its direction; its scale as a distance or a zoom).
  const current = (): View => ({ pos: cam.position.clone(), target: controls.current!.target.clone(), height: viewHeight(cam, cam.position, controls.current!.target, vh) });
  const show = (v: View) => {
    const c = controls.current!;
    const at = placeFor(v, cam, vh, reach);
    cam.position.copy(at.pos);
    if (at.zoom) { (cam as THREE.OrthographicCamera).zoom = at.zoom; (cam as THREE.OrthographicCamera).updateProjectionMatrix(); }
    c.target.copy(v.target);
    c.update();
  };
  // A sweep under way: from a view (in the pivot's frame) to this camera's own.
  // Its progress goes by frame time capped at 50 ms a frame, so a stalled frame slows it rather than jumping.
  const anim = useRef<{ from: View; dest: View; u: number } | null>(null);
  const opened = useRef(false);
  const lastMode = useRef(mode);
  const sweepTo = (dest: View) => {
    const c = controls.current;
    const p = pivot();
    if (!c || !p) return;
    anim.current = { from: local(p, current()), dest, u: 0 };
    c.enabled = false;
  };
  // Opening: start from the last view's camera around the car (same scale), then sweep to this camera's own.
  // Changing to chase / overhead (or what they follow): sweep to where that camera was left (or its default).
  // Changing to free: unlock where the camera is (its pivot: the track where the car is now).
  useEffect(() => {
    const c = controls.current, car = carPose();
    if (!active) { opened.current = false; anim.current = null; if (c) c.enabled = true; return; }
    if (!c) return;
    const switchedToFree = opened.current && mode === 'free' && lastMode.current !== 'free';
    lastMode.current = mode;
    if (switchedToFree) {
      anim.current = null; c.enabled = true;
      freeAt = carDistance();
      prev.current = pivot();
      return;
    }
    if (mode === 'free' && freeAt === null) freeAt = carDistance();
    if (!opened.current) {
      opened.current = true;
      const last = car ? lastAroundCar() : null;
      const p = pivot(), h = home();
      if (last) show(last);
      else if (p) show(world(p, h));
    }
    prev.current = pivot();
    const mem = recallView(key);
    sweepTo(mem ? { pos: mem.pos, target: mem.target, height: mem.height ?? view(mem.pos, mem.target).height } : home());
  }, [mode, follow, active]); // eslint-disable-line react-hooks/exhaustive-deps
  // The button clicked again: back to the default (free: back to the car).
  const firstReset = useRef(resetKey);
  useEffect(() => {
    if (resetKey === firstReset.current) return;
    if (mode === 'free') { const c = controls.current, p0 = pivot(); freeAt = carDistance(); const p1 = pivot(); if (c && p0 && p1) { prev.current = p1; cam.position.copy(toWorld(p1, toLocal(p0, cam.position))); c.target.copy(toWorld(p1, toLocal(p0, c.target))); } }
    sweepTo(home());
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Free: right-drag (or Shift + drag) slides the pivot along the track, like grabbing the ground.
  useEffect(() => {
    if (mode !== 'free' || !active) return;
    const el = gl.domElement;
    let last: { x: number; y: number } | null = null;
    const toPx = (v: THREE.Vector3, r: DOMRect) => { const q = v.clone().project(cam); return new THREE.Vector2(((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height); };
    const down = (e: PointerEvent) => {
      if (e.button !== 2 && !(e.button === 0 && e.shiftKey)) return;
      e.preventDefault(); e.stopPropagation();
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      const d0 = freeAt ?? 0, a = trackAt(d0), b = trackAt(Math.min(length, d0 + 1)) ?? a, b2 = trackAt(Math.max(0, d0 - 1)) ?? a;
      if (!a || !b || !b2) return;
      const r = el.getBoundingClientRect();
      // The track's direction on screen (pixels per metre along it); dragging along it moves the other way.
      const v = toPx(b.pos, r).sub(toPx(b2.pos, r)).multiplyScalar(0.5);
      const len2 = Math.max(v.lengthSq(), 4);
      const ds = -(dx * v.x + dy * v.y) / len2;
      const step = Math.max(-5, Math.min(5, ds)); // at most 5 m per move (the track seen end-on)
      freeAt = Math.max(0, Math.min(length, d0 + step));
    };
    const up = (e: PointerEvent) => { if (last) { last = null; try { el.releasePointerCapture(e.pointerId); } catch { /* gone */ } } };
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down, { capture: true });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('contextmenu', menu);
    return () => {
      el.removeEventListener('pointerdown', down, { capture: true });
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('contextmenu', menu);
    };
  }, [mode, active, gl, cam, trackAt, length]);

  // Dev only: lets automated UI checks read the camera (window.__courseCam).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __courseCam?: () => unknown }).__courseCam = () => ({ pos: cam.position.toArray(), target: controls.current?.target.toArray(), car: carPose()?.pos.toArray(), freeAt, anim: !!anim.current, ortho, height: controls.current ? current().height : null });
  });
  const inv = useMemo(() => new THREE.Matrix4(), []);
  // The last view's camera around the car (the same scale), as a view here.
  const lastAroundCar = (): View | null => {
    const car = carPose();
    const last = car ? lastCamera((v) => v.applyMatrix4(carMatrix(car, groundY))) : null;
    return last ? { pos: last.pos, target: last.target, height: last.height ?? 2 * last.pos.distanceTo(last.target) * TAN_HALF_45 } : null;
  };
  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    // Still drawn under the view now shown (fading out): follow its camera around the car.
    if (!active) {
      const last = isLeaving(SLOT) ? lastAroundCar() : null;
      if (last) show(last);
      return;
    }
    const p = pivot();
    if (!p) return;
    const a = anim.current;
    if (a) {
      // Sweep: the target slides across, the camera orbits round it, the scale eases (log); the view fades in with it.
      a.u = Math.min(1, a.u + sweepStep(delta));
      show(between(world(p, a.from), world(p, a.dest), ease(a.u)) as View);
      fadeIn(SLOT, a.u);
      if (a.u >= 1) { anim.current = null; c.enabled = true; }
    } else {
      if (opened.current) fadeIn(SLOT, 1);
      // Carry the camera: move by the pivot's move, turn by its turn about it.
      const pr = prev.current ?? p;
      cam.position.copy(toWorld(p, toLocal(pr, cam.position)));
      c.target.copy(toWorld(p, toLocal(pr, c.target)));
      c.update();
    }
    prev.current = { ...p, pos: p.pos.clone() };
    // Remember this camera (in its own frame; mid-sweep, where it is heading) and the camera around the car
    // now (the next view opened starts there).
    const car = carPose();
    if (car && opened.current) {
      inv.copy(carMatrix(car, groundY)).invert();
      const now = current();
      rememberView(key, now, (v) => v.applyMatrix4(inv), anim.current ? anim.current.dest : local(p, now));
    }
  });
  return <OrbitControls ref={controls as never} makeDefault enableDamping={false} enablePan={false}
    maxDistance={size * 40} minDistance={size * 0.3} minZoom={vh / (size * 60)} maxZoom={vh / (size * 0.4)} />;
}

export function CourseViewport({ model, test, ghosts = [], active = true }: {
  model: VehicleModel | null; test: TestDesign | null; ghosts?: { frames: PlaybackFrame[]; color: string; label: string; wheelbase?: number; model?: VehicleModel | null }[]; active?: boolean;
}) {
  const tv = useTestView();
  // Only the frames (not the playback time: that is read each frame, so the view doesn't re-render per tick).
  const pbFrames = usePlayback((st) => st.frames), pbTest = usePlayback((st) => st.testId);
  const [resetKey, setResetKey] = useState(0);
  const segs = useMemo(() => (test ? test.segments.map((sg) => segmentSpec(sg, test)) : []), [test]);
  const points = useMemo(() => course(segs), [segs]);
  const segStart = useMemo(() => { const o: number[] = []; segs.reduce((a, sg) => { o.push(a); return a + sg.distance; }, 0); return o; }, [segs]);
  // The car's overall width (track + tire) sets the road width where a segment has none of its own.
  const corners = useApp((st) => st.corners), geom = useApp((st) => st.geom);
  const dims = useMemo(() => {
    const d = mergedCorners(useApp.getState())[rootOf('FL', useApp.getState().links)];
    const halfTrack = Math.abs(d.geom.points.wheelCenter[0].value) / 1000;
    const tire = d.geom.scalars.tireWidth.value / 1000;
    return { width: 2 * halfTrack + tire, track: 2 * halfTrack * 1000 };
  }, [corners, geom]);
  const halfWidth = useMemo(() => (seg: number) => {
    const w = test?.segments[seg]?.width?.value;
    return (w && w > 0 ? w : dims.width * tv.widthFactor) / 2;
  }, [test, dims.width, tv.widthFactor]);
  const frames = useMemo(() => (pbTest === test?.id ? pbFrames : []), [pbTest, pbFrames, test?.id]);
  // The pose now (playback time), shared by the car and the camera; at the start before Play.
  // No test chosen (no course): the car stands at the origin, so the cameras still have it to go round.
  const poseOf = useMemo(() => (onCenter: boolean): Pose => {
    const at = poseAt(points, segStart, frames, usePlayback.getState().t, onCenter);
    if (at) return at;
    const p0 = points[0];
    return p0 ? { pos: toScene(p0.x, p0.y, p0.z), heading: p0.heading, grade: p0.grade, bank: p0.bank } : { pos: new THREE.Vector3(), heading: 0, grade: 0, bank: 0 };
  }, [points, segStart, frames]);
  const poseNow = useMemo(() => () => poseOf(false), [poseOf]);
  // The car's distance from the start now (m), and a point of the track's center line at a distance (the free pivot).
  const carDistance = useMemo(() => () => {
    if (!frames.length) return 0;
    const t = usePlayback.getState().t;
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (frames[m]!.t <= t) lo = m; else hi = m - 1; }
    const f = frames[lo]!;
    // (The middle of the car, as chase / overhead follow: half a wheelbase behind the front axle.)
    return Math.max(0, (segStart[f.segment] ?? 0) + f.s - (model?.wheelbase ?? 1550) / 2000);
  }, [frames, segStart, model?.wheelbase]);
  const length = points.length ? points[points.length - 1]!.total : 0;
  const trackAt = useMemo(() => (d: number): Pose | null => {
    if (!points.length) return { pos: new THREE.Vector3(), heading: 0, grade: 0, bank: 0 };
    let seg = 0;
    while (seg + 1 < segStart.length && segStart[seg + 1]! <= d) seg++;
    const q = placeOnCourse(points, segStart, { segment: seg, s: d - (segStart[seg] ?? 0), grade: 0, bank: 0, handling: undefined });
    return { pos: toScene(q.x, q.y, q.z), heading: q.heading, grade: 0, bank: 0 };
  }, [points, segStart]);
  // Chase / overhead go round the middle of the car (half a wheelbase behind the front axle, which the frames
  // place; in the car's own frame the front axle is at z = 0, the rear at −wheelbase), not its front axle.
  const halfBase = (model?.wheelbase ?? 1550) / 2;
  const followPose = useMemo(() => () => {
    const p = poseOf(tv.follow === 'track');
    const back = new THREE.Vector3(0, 0, -halfBase).applyEuler(new THREE.Euler(-p.grade, p.heading, -p.bank, 'YXZ'));
    return { ...p, pos: p.pos.clone().add(back) };
  }, [poseOf, tv.follow, halfBase]);
  // The track's middle and size, and the ground just below its lowest point.
  const extent = useMemo(() => {
    if (!points.length) return { center: new THREE.Vector3(), span: 20000, low: 0 };
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y), zs = points.map((p) => p.z);
    const mid = (a: number[]) => (Math.min(...a) + Math.max(...a)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 20) * 1000;
    return { center: toScene(mid(xs), mid(ys), mid(zs)), span, low: Math.min(...zs) * 1000 };
  }, [points]);
  const groundOn = useApp((st) => st.visibility.ground);
  const bg = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue('--viewport-bg').trim() || '#16191e', []);
  const pathLine = useMemo(() => points.map((p) => [p.y * 1000, p.z * 1000 + 15, p.x * 1000] as [number, number, number]), [points]);
  // The line driven, one piece per segment colored by its result (the worst of its frames).
  const driven = useMemo(() => {
    if (!points.length || !frames.length) return [];
    const rank = { pass: 0, warn: 1, fail: 2 } as Record<string, number>;
    const pieces: { pts: [number, number, number][]; sev: string }[] = [];
    for (const f of frames) {
      const q = placeOnCourse(points, segStart, f);
      const pt: [number, number, number] = [q.y * 1000, q.z * 1000 + 25, q.x * 1000];
      const last = pieces[pieces.length - 1];
      if (!last || (last as { seg?: number }).seg !== f.segment) {
        if (last) last.pts.push(pt); // join the pieces
        pieces.push(Object.assign({ pts: [pt], sev: f.severity }, { seg: f.segment }));
      } else {
        last.pts.push(pt);
        if ((rank[f.severity] ?? 0) > (rank[last.sev] ?? 0)) last.sev = f.severity;
      }
    }
    return pieces.filter((p) => p.pts.length > 1);
  }, [frames, points, segStart]);
  const size = Math.max(2500, (model?.wheelbase ?? 1550) * 1.6);
  // Perspective (default) or orthographic, this view's own setting; an orthographic camera stands this far back (clear of the course).
  const projection = tv.projection === 'orthographic' ? 'orthographic' : 'perspective';
  const reach = extent.span * 1.5 + 100000;
  return (
    <div className="viewport">
      {/* A logarithmic depth buffer: the road, the ground and the car stay apart from 10 mm to kilometres away. */}
      <Canvas key={projection} dpr={[1, 2]} style={{ position: 'absolute', inset: 0 }} gl={{ logarithmicDepthBuffer: true }} frameloop={active ? 'always' : 'never'}>
        <color attach="background" args={[bg]} />
        {projection === 'orthographic'
          ? <OrthographicCamera makeDefault position={[0, size, -size * 2]} zoom={0.2} near={1} far={reach * 4} />
          : <PerspectiveCamera makeDefault position={[0, size, -size * 2]} fov={45} near={10} far={2e6} />}
        <ambientLight intensity={0.7} />
        <directionalLight position={[20000, 40000, 10000]} intensity={1.1} />
        {points.length > 1 && <Road points={points} segs={segs} halfWidth={halfWidth} />}
        {pathLine.length > 1 && <Line points={pathLine} color="#8a93a3" lineWidth={1.5} dashed dashSize={1500} gapSize={1000} />}
        {driven.map((p, i) => <Line key={i} points={p.pts} color={SEV[p.sev] ?? '#ffffff'} lineWidth={2.5} />)}
        <CarOnCourse model={model} poseNow={poseNow} />
        {ghosts.map((g) => <GhostCar key={g.label} frames={g.frames} model={g.model} points={points} segStart={segStart} />)}
        {/* The ground just below the course's lowest point (it can't cut through the road), potholes included. */}
        {groundOn && <CourseGround center={extent.center} low={extent.low} span={extent.span} bg={bg} />}
        <FadeRoot viewKey={SLOT} />
        <CourseCamera active={active} mode={tv.camera} follow={tv.follow} followPose={followPose} carPose={poseNow} carDistance={carDistance} trackAt={trackAt} length={length} groundY={model?.groundY ?? 0} size={size} reach={reach} resetKey={resetKey} />
      </Canvas>
      <div className="course-camera">
        <div className="cam-row">
          <button className="toggle" onClick={() => setTestView({ projection: projection === 'orthographic' ? 'perspective' : 'orthographic' })} title="Toggle projection (this view only; the other views have their own)">
            {projection === 'orthographic' ? 'Ortho' : 'Persp'}
          </button>
        </div>
        <div className="cam-row">
        {(['chase', 'overhead', 'free'] as const).map((c) => (
          <button key={c} className={`chip${tv.camera === c ? ' on' : ''}`}
            title={c === 'chase' ? 'Behind and above, following; drag to orbit round, scroll to zoom. Click again to get back behind' : c === 'overhead' ? 'Straight down, following; drag to orbit, scroll to zoom. Click again to look straight down again' : 'Unlock from the car where the camera is: drag to look round, right-drag (or Shift + drag) to slide along the track, scroll to zoom. Click again to go back to the car'}
            onClick={() => { if (c === tv.camera) setResetKey((k) => k + 1); else setTestView({ camera: c }); }}>{c === 'chase' ? 'Chase' : c === 'overhead' ? 'Overhead' : 'Free'}</button>
        ))}
        </div>
        <div className="cam-row">
        <span className="muted small-text" title="What chase and overhead follow">Follow</span>
        {(['vehicle', 'track'] as const).map((f) => (
          <button key={f} className={`chip${tv.follow === f ? ' on' : ''}`} disabled={tv.camera === 'free'}
            title={f === 'vehicle' ? 'Follow the car itself' : 'Follow the point of the track\u2019s center line nearest the car (steadier: the car\u2019s wander off the line and its sideslip don\u2019t swing the view)'}
            onClick={() => setTestView({ follow: f })}>{f === 'vehicle' ? 'Vehicle' : 'Track'}</button>
        ))}
        </div>
        <div className="cam-row">
        <span className="muted small-text" title="Road width where a segment has no track width of its own">Road</span>
        <select value={tv.widthFactor} onChange={(e) => setTestView({ widthFactor: Number(e.target.value) })} title="Road width: a share of the car's overall width (a segment's own track width wins)">
          <option value={1.5}>150 % of the car</option>
          <option value={2}>200 % of the car</option>
        </select>
        </div>
      </div>
      {!frames.length && <div className="viewport-hint">▶ Play (or Space) drives the car through the course.</div>}
    </div>
  );
}
