/**
 * Tests: the Dynamic view (round 3, V2; docs/MATH.md § Tests, dynamic view): the course in 3D from the
 * segments (turns, bank, grade, the road's bumps / potholes / rough patches, the path and the line driven)
 * with the car driving along it from the playback frames. One timeline with the Static view (Playback.tsx).
 * Several runs can be shown at once (`ghosts`: other frame sets drawn as see-through cars), so the compare
 * window (R9) can race a snapshot on the same course.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { create } from 'zustand';
import { useApp, mergedCorners, rootOf } from '../store';
import { segmentSpec, type TestDesign } from '../tests';
import { course, courseRoadHeight, placeOnCourse, type CoursePoint } from '../../core/tests/course';
import type { PlaybackFrame } from '../../core/tests/run';
import type { VehicleModel } from '../useVehicle';
import { VehicleScene } from './VehicleView';
import { COLORS } from './Scene';
import { usePlayback } from '../panels/Playback';
import { Line } from './primitives';

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
}
const load = (): Partial<TestViewState> => { try { return JSON.parse(localStorage.getItem('susp.testView') ?? '{}') as Partial<TestViewState>; } catch { return {}; } };
export const useTestView = create<TestViewState>(() => ({ mode: 'static', camera: 'chase', follow: 'vehicle', widthFactor: 1.5, ...load() }));
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
      <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.95} />
    </mesh>
  );
}

type Pose = { pos: THREE.Vector3; heading: number; grade: number; bank: number };

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

/** Another run on the same course: a see-through car (body and wheels) from its frames. */
function GhostCar({ frames, color, wheelbase, track, points, segStart }: { frames: PlaybackFrame[]; color: string; wheelbase: number; track: number; points: CoursePoint[]; segStart: number[] }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const at = poseAt(points, segStart, frames, usePlayback.getState().t);
    if (!at || !group.current) return;
    group.current.position.copy(at.pos);
    group.current.rotation.set(-at.grade, at.heading, -at.bank, 'YXZ');
  });
  return (
    <group ref={group}>
      <mesh position={[0, 450, -wheelbase / 2]}>
        <boxGeometry args={[track * 0.9, 500, wheelbase * 1.3]} />
        <meshStandardMaterial color={color} transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </group>
  );
}

/**
 * Cameras. Chase and overhead orbit around what they follow (drag to look round, scroll to zoom) while it
 * carries them along and turns them with it; clicking the button again puts the camera back (behind and
 * above for chase, straight down for overhead). They follow the car, or the point of the track's center
 * line nearest it (steadier: the car's wander off the line and its sideslip don't swing the view). Free
 * orbits about the track's center, which can't be dragged away (no panning): zoom always works.
 * The car and the camera read the same pose each frame (no lag between them).
 */
function CourseCamera({ mode, followPose, size, resetKey, center, span }: {
  mode: CourseCamera; followPose: () => Pose | null; size: number; resetKey: number; center: THREE.Vector3; span: number;
}) {
  const cam = useThree((st) => st.camera);
  const controls = useRef<{ target: THREE.Vector3; update: () => void } | null>(null);
  const prev = useRef<Pose | null>(null);
  const up = useMemo(() => new THREE.Vector3(0, mode === 'chase' ? size * 0.25 : 0, 0), [size, mode]);
  // Where each camera starts (and goes back to).
  useEffect(() => {
    if (mode === 'free') {
      cam.position.copy(center).add(new THREE.Vector3(span * 0.35, span * 0.6, -span * 0.55));
      if (controls.current) { controls.current.target.copy(center); controls.current.update(); }
      prev.current = null;
      return;
    }
    const p = followPose();
    if (!p) return;
    const fwd = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
    if (mode === 'chase') cam.position.copy(p.pos).addScaledVector(fwd, -size * 2.2).add(new THREE.Vector3(0, size * 0.9, 0));
    else cam.position.copy(p.pos).addScaledVector(fwd, -size * 0.02).add(new THREE.Vector3(0, size * 2.4, 0));
    if (controls.current) { controls.current.target.copy(p.pos).add(up); controls.current.update(); }
    prev.current = { ...p, pos: p.pos.clone() };
  }, [mode, resetKey, size, center, span]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(() => {
    if (mode === 'free' || !controls.current) return;
    const p = followPose();
    if (!p) return;
    const pr = prev.current ?? p;
    // Carry the camera: move by the target's move, turn by its turn about it.
    const off = cam.position.clone().sub(pr.pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.heading - pr.heading);
    cam.position.copy(p.pos).add(off);
    controls.current.target.copy(p.pos).add(up);
    controls.current.update();
    prev.current = { ...p, pos: p.pos.clone() };
  });
  return <OrbitControls ref={controls as never} makeDefault enableDamping={false} enablePan={mode !== 'free'} />;
}

export function CourseViewport({ model, test, ghosts = [] }: {
  model: VehicleModel | null; test: TestDesign | null; ghosts?: { frames: PlaybackFrame[]; color: string; label: string }[];
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
  const poseOf = useMemo(() => (onCenter: boolean) => {
    const at = poseAt(points, segStart, frames, usePlayback.getState().t, onCenter);
    if (at) return at;
    const p0 = points[0];
    return p0 ? { pos: toScene(p0.x, p0.y, p0.z), heading: p0.heading, grade: p0.grade, bank: p0.bank } : null;
  }, [points, segStart, frames]);
  const poseNow = useMemo(() => () => poseOf(false), [poseOf]);
  const followPose = useMemo(() => () => poseOf(tv.follow === 'track'), [poseOf, tv.follow]);
  // The track's middle and size (the free camera's pivot), and the ground just below its lowest point.
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
  return (
    <div className="viewport">
      <Canvas dpr={[1, 2]} style={{ position: 'absolute', inset: 0 }}>
        <color attach="background" args={[bg]} />
        <PerspectiveCamera makeDefault position={[0, size, -size * 2]} fov={45} near={10} far={2e6} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[20000, 40000, 10000]} intensity={1.1} />
        {points.length > 1 && <Road points={points} segs={segs} halfWidth={halfWidth} />}
        {pathLine.length > 1 && <Line points={pathLine} color="#8a93a3" lineWidth={1.5} dashed dashSize={1500} gapSize={1000} />}
        {driven.map((p, i) => <Line key={i} points={p.pts} color={SEV[p.sev] ?? '#ffffff'} lineWidth={2.5} />)}
        <CarOnCourse model={model} poseNow={poseNow} />
        {ghosts.map((g) => <GhostCar key={g.label} frames={g.frames} color={g.color} wheelbase={model?.wheelbase ?? 1550} track={dims.track} points={points} segStart={segStart} />)}
        {/* The ground just below the course's lowest point (it can't cut through the road), potholes included. */}
        {groundOn && (
          <Grid position={[extent.center.x, extent.low - 120, extent.center.z]} args={[10000, 10000]} cellSize={1000} sectionSize={5000}
            cellColor={COLORS.ground} sectionColor="#566075" fadeDistance={extent.span * 2 + 50000} infiniteGrid />
        )}
        <CourseCamera mode={tv.camera} followPose={followPose} size={size} resetKey={resetKey} center={extent.center} span={extent.span} />
      </Canvas>
      <div className="course-camera">
        <div className="cam-row">
        {(['chase', 'overhead', 'free'] as const).map((c) => (
          <button key={c} className={`chip${tv.camera === c ? ' on' : ''}`}
            title={c === 'chase' ? 'Behind and above, following; drag to orbit round, scroll to zoom. Click again to get back behind' : c === 'overhead' ? 'Straight down, following; drag to orbit, scroll to zoom. Click again to look straight down again' : 'Orbit about the track\u2019s center (it stays put); scroll to zoom. Click again to reset'}
            onClick={() => { setResetKey((k) => k + 1); setTestView({ camera: c }); }}>{c === 'chase' ? 'Chase' : c === 'overhead' ? 'Overhead' : 'Free'}</button>
        ))}
        </div>
        <div className="cam-row">
        <span className="muted small-text" title="What chase and overhead follow">Follow</span>
        {(['vehicle', 'track'] as const).map((f) => (
          <button key={f} className={`chip${tv.follow === f ? ' on' : ''}`} disabled={tv.camera === 'free'}
            title={f === 'vehicle' ? 'Follow the car itself' : 'Follow the point of the track\u2019s center line nearest the car (steadier: the car\u2019s wander off the line and its sideslip don\u2019t swing the view)'}
            onClick={() => { setTestView({ follow: f }); setResetKey((k) => k + 1); }}>{f === 'vehicle' ? 'Vehicle' : 'Track'}</button>
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
