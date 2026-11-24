/**
 * Vehicle viewport (L6): the four corners on the chassis, posed by the solved heave/roll/pitch, with
 * contact patches, tire load / lateral force arrows, the CG and the roll axis. Double-click a corner
 * to edit it in the Corner view.
 */
import { linkageShape } from './linkageShape';
import type { CornerPoints } from '../../core/suspension/doubleWishbone';
import { useDisplay } from '../units';
import { useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { switchWorkspace } from './SafeHtml';
import * as THREE from 'three';
import { vec3, add, sub, scale, normalize, type Vec3 } from '../../core/math/vec3';
import { closestPointOnLine, lineThrough } from '../../core/math/geom';
import { CORNER_IDS, placement, poseFns, isLeft, type CornerId } from '../../core/vehicle/vehicle';
import { useApp, FORCE_KEYS, FORCE_META, mergedCorners, rootOf, layoutOf, activePointKeys, POINT_NAMES, type ForceKey, type VisKey, type PointKey } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { STATE_KEY } from '../anchors';
import { VehicleMoveGizmo, AxisGizmo } from './JointGizmo';
import { SafeHtml as Html } from './SafeHtml';
import { pointAxisLocked } from '../locks';
import type { VehicleModel, VehicleCornerView, AckermannAxle } from '../useVehicle';
import { CameraRig, DevProjectBridge, ViewButtons, useMiddleDoubleClick, type FocusTarget } from './Viewport';
import { COLORS, CustomDrawing } from './Scene';
import { Joint, Seg, Polyline, Tri, Wheel, PatchMesh, Coilover, Arrow } from './primitives';

/** Types with one axle under both wheels (solid axles, twist beam). */
const AXLE_KINDS: string[] = ['beam4', 'beam3', 'beamWatts', 'beamLeaf', 'twistBeam'];

/** One corner drawn in the vehicle frame. Right corners are mirrored point-by-point (a negative
 *  scale on the group would flip the line quads' winding and cull them). */
function CornerDrawing({ view, onOpen, active, wheelbase }: { view: VehicleCornerView; onOpen: () => void; active: boolean; wheelbase: number }) {
  const simpleTire = useApp((s) => s.simpleTire);
  const vis = useApp((s) => s.visibility);
  const pl = placement(view.id, wheelbase);
  const raw = view.state.points;
  const m = (v: Vec3 | undefined) => (v ? pl.point(v) : undefined);
  const p = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, m(v as Vec3)])) as unknown as CornerPoints;
  if (raw.crossTieRod) p.crossTieRod = [pl.point(raw.crossTieRod[0]), pl.point(raw.crossTieRod[1])];
  if (raw.wattsLinks) p.wattsLinks = raw.wattsLinks.map(([x, y]) => [pl.point(x), pl.point(y)] as [Vec3, Vec3]);
  if (raw.axleEnds) p.axleEnds = [pl.point(raw.axleEnds[0]), pl.point(raw.axleEnds[1])];
  // A solid axle or twist beam is one part under both wheels: the left corner draws the shared parts once.
  const oneAxle = AXLE_KINDS.includes(view.state.kind);
  const sh = linkageShape(p, view.state.kind, oneAxle ? (isLeft(view.id) ? 'left' : 'right') : 'whole');
  const axis = pl.dir(view.state.spinAxis);
  const foot = closestPointOnLine(lineThrough(sh.axis[0], sh.axis[1]), p.wheelCenter);
  const w = active ? 3.5 : 2.5;
  return (
    <group
      onDoubleClick={(e) => { e.stopPropagation(); onOpen(); }}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    >
      {vis.uca && sh.ucaTri && <Tri a={sh.ucaTri[0]} b={sh.ucaTri[1]} c={sh.ucaTri[2]} color={COLORS.uca} opacity={0.22} />}
      {vis.uca && sh.uca.map(([a, b], i) => <Seg key={i} a={a} b={b} color={COLORS.uca} width={w} />)}
      {vis.lca && sh.lcaTri && <Tri a={sh.lcaTri[0]} b={sh.lcaTri[1]} c={sh.lcaTri[2]} color={COLORS.lca} opacity={0.22} />}
      {vis.lca && sh.lca.map(([a, b], i) => <Seg key={i} a={a} b={b} color={COLORS.lca} width={w} />)}
      {vis.upright && <Polyline pts={sh.upright} color={COLORS.upright} width={w} />}
      {vis.upright && <Seg a={foot} b={p.wheelCenter} color={COLORS.upright} width={w} />}
      {view.state.kind === 'custom' && raw.customJoints && <CustomDrawing p={{ ...p, customJoints: raw.customJoints.map((j) => ({ ...j, pts: j.pts.map((q) => pl.point(q)) })) }} width={w} />}
      {vis.tieRod && (!oneAxle && view.state.kind !== 'custom' || (!!p.crossTieRod && isLeft(view.id))) && <Seg a={p.trInner} b={p.trOuter} color={COLORS.tieRod} width={w} />}
      {vis.tieRod && p.crossTieRod && isLeft(view.id) && <Seg a={p.crossTieRod[0]} b={p.crossTieRod[1]} color={COLORS.tieRod} width={w} />}
      {vis.spring && p.damperChassis && p.damperArm && <Coilover a={p.damperChassis} b={p.damperArm} color={COLORS.spring} radius={22} coils={7} />}
      {vis.spring && p.rockerPivot1 && p.rockerPivot2 && p.pushrodUpper && p.pushrodLower && p.damperArm && (
        <>
          <Polyline pts={[p.rockerPivot1, p.pushrodUpper, p.damperArm, p.rockerPivot1]} color={COLORS.spring} width={w} />
          <Seg a={p.pushrodLower} b={p.pushrodUpper} color={COLORS.tieRod} width={w} />
        </>
      )}
      {(vis.uca || vis.upright) && view.state.kind !== 'macpherson' && view.state.kind !== 'custom' && <Joint p={p.ucaOut} color={COLORS.uca} r={8} />}
      {(vis.lca || vis.upright) && view.state.kind !== 'custom' && <Joint p={p.lcaOut} color={COLORS.lca} r={8} />}
      {vis.wheel && <Wheel
        center={p.wheelCenter} axis={axis} radius={view.profile.radius} width={view.profile.width}
        rimRadius={view.profile.rimRadius} color={active ? '#ffffff' : COLORS.wheel} simple={simpleTire}
        shoulder={simpleTire ? 0 : view.profile.shoulderRadius}
      />}
    </group>
  );
}

/** Chassis rails joining the corners' inboard pivots (vehicle frame). */
function Frame({ model }: { model: VehicleModel }) {
  const pts = useMemo(() => {
    const at = (id: CornerId, k: 'ucaFwd' | 'ucaAft' | 'lcaFwd' | 'lcaAft') => {
      const v = model.corners[id];
      return v ? placement(id, model.wheelbase).point(v.state.points[k]) : null;
    };
    const lines: [Vec3, Vec3][] = [];
    const push = (a: Vec3 | null, b: Vec3 | null) => { if (a && b) lines.push([a, b]); };
    for (const arm of ['uca', 'lca'] as const) {
      const fwd = `${arm}Fwd` as const;
      const aft = `${arm}Aft` as const;
      push(at('FL', fwd), at('FR', fwd)); // cross members
      push(at('RL', aft), at('RR', aft));
      push(at('FL', aft), at('RL', fwd)); // side rails
      push(at('FR', aft), at('RR', fwd));
    }
    return lines;
  }, [model]);
  return <>{pts.map(([a, b], i) => <Seg key={i} a={a} b={b} color={COLORS.chassis} width={2} opacity={0.8} />)}</>;
}

/** Torsion anti-roll bars: drop-link mounts on each lower arm, joined across the car (chassis frame). */
function AntiRollBars({ model }: { model: VehicleModel }) {
  const r = model.result;
  if (!r) return null;
  const P = poseFns(r.pose);
  const bars: [Vec3, Vec3][] = [];
  for (const [l, rr] of [['FL', 'FR'], ['RL', 'RR']] as const) {
    const a = model.corners[l]?.dropLink;
    const b = model.corners[rr]?.dropLink;
    if (a && b) bars.push([P.point(placement(l, model.wheelbase).point(a)), P.point(placement(rr, model.wheelbase).point(b))]);
  }
  return (
    <>
      {bars.map(([a, b], i) => (
        <group key={i}>
          <Seg a={a} b={b} color="#c77dff" width={3} dashed />
          <Joint p={a} color="#c77dff" r={8} />
          <Joint p={b} color="#c77dff" r={8} />
        </group>
      ))}
    </>
  );
}

interface ForceArrow { key: string; kind: ForceKey; from: Vec3; vec: Vec3; label: string }

const G = 9.80665;

/** Every force that can be shown, as an arrow starting at its point of action (world, N). */
function forceList(model: VehicleModel): ForceArrow[] {
  const r = model.result;
  if (!r) return [];
  const P = poseFns(r.pose);
  const out: ForceArrow[] = [];
  for (const id of CORNER_IDS) {
    const c = r.corners[id];
    const v = model.corners[id];
    const at = v?.patch?.centroid ?? c.contact;
    out.push({ key: `${id}-fz`, kind: 'tireVertical', from: at, vec: vec3(0, c.tireLoad, 0), label: `${id} ${c.tireLoad.toFixed(0)} N` });
    out.push({ key: `${id}-fy`, kind: 'tireLateral', from: at, vec: vec3(c.lateralForce, 0, 0), label: `${id} lat ${c.lateralForce.toFixed(0)} N` });
    if (c.brakeForce) out.push({ key: `${id}-fb`, kind: 'tireLongitudinal', from: at, vec: vec3(0, 0, c.brakeForce), label: `${id} brake ${(-c.brakeForce).toFixed(0)} N` });
    if (c.driveForce) out.push({ key: `${id}-fd`, kind: 'tireLongitudinal', from: at, vec: vec3(0, 0, c.driveForce), label: `${id} drive ${c.driveForce.toFixed(0)} N` });
    if (v) {
      const pl = placement(id, model.wheelbase);
      const toW = (q: Vec3) => P.point(pl.point(q));
      const pts = v.state.points;
      if (pts.damperChassis && pts.damperArm && c.springForce > 0) {
        const ch = toW(pts.damperChassis);
        const arm = toW(pts.damperArm);
        const d = normalize(sub(ch, arm));
        out.push({ key: `${id}-sb`, kind: 'springs', from: ch, vec: scale(d, c.springForce), label: `${id} spring ${c.springForce.toFixed(0)} N (on body)` });
        out.push({ key: `${id}-sa`, kind: 'springs', from: arm, vec: scale(d, -c.springForce), label: `${id} spring (on arm)` });
      }
      if (Math.abs(c.sharedForce) > 0.5) {
        out.push({ key: `${id}-sh`, kind: 'shared', from: c.wheelCenter, vec: vec3(0, c.sharedForce, 0), label: `${id} bar/heave ${c.sharedForce.toFixed(0)} N` });
      }
      out.push({ key: `${id}-wu`, kind: 'weights', from: c.wheelCenter, vec: vec3(0, -v.unsprungMass * G, 0), label: `${id} unsprung ${(v.unsprungMass * G).toFixed(0)} N` });
    }
  }
  if (model.sprungCgWorld) {
    const m = r.sprungMass;
    out.push({ key: 'ws', kind: 'weights', from: model.sprungCgWorld, vec: vec3(0, -m * G, 0), label: `sprung weight ${(m * G).toFixed(0)} N` });
    const lat = -m * model.accel.lateral * G;
    const lon = -m * model.accel.longitudinal * G;
    if (Math.abs(lat) > 1) out.push({ key: 'il', kind: 'inertia', from: model.sprungCgWorld, vec: vec3(lat, 0, 0), label: `inertia lat ${Math.abs(lat).toFixed(0)} N` });
    if (Math.abs(lon) > 1) out.push({ key: 'iz', kind: 'inertia', from: model.sprungCgWorld, vec: vec3(0, 0, lon), label: `inertia long ${Math.abs(lon).toFixed(0)} N` });
  }
  return out;
}

function ForceArrows({ arrows }: { arrows: ForceArrow[] }) {
  const k = useApp((s) => s.forceScale);
  return (
    <>
      {arrows.map((a) => <Arrow key={a.key} from={a.from} vec={scale(a.vec, k)} color={FORCE_META[a.kind].color} />)}
    </>
  );
}

/** The car (and its forces, markers). `ground`: its own ground grid (off when it sits on a course). */
export function VehicleScene({ model, arrows, ground = true }: { model: VehicleModel; arrows: ForceArrow[]; ground?: boolean }) {
  const setActiveCorner = useApp((s) => s.setActiveCorner);
  const activeCorner = useApp((s) => s.activeCorner);
  const vis = useApp((s) => s.visibility);
  const r = model.result;
  if (!r) return null;
  const pose = r.pose;
  const euler = new THREE.Euler(pose.pitch, 0, pose.roll, 'ZXY');
  const rcF = model.rollCenters.front;
  const rcR = model.rollCenters.rear;
  const open = (id: CornerId) => { setActiveCorner(id); switchWorkspace('corner'); };
  const frame = useRef<THREE.Group>(null);
  const measureMode = useApp((s) => s.measureMode);
  return (
    <group>
      <ambientLight intensity={0.8} />
      <directionalLight position={[1500, 2500, 2000]} intensity={1.2} />
      {vis.ground && ground && (
        <Grid
          position={[0, model.groundY, -model.wheelbase / 2]} args={[8000, 8000]} cellSize={50} sectionSize={250}
          cellColor={COLORS.ground} sectionColor="#566075" fadeDistance={12000} infiniteGrid
        />
      )}
      {/* Chassis (everything sprung) moves with the solved pose. */}
      <group ref={frame} position={[0, pose.heave, 0]} rotation={euler}>
        {vis.chassis && <Frame model={model} />}
        {vis.ackermann && <AckermannLines model={model} frame={frame} />}
        <VehiclePoints model={model} frame={frame} />
        {CORNER_IDS.map((id) => {
          const v = model.corners[id];
          if (!v) return null;
          return <CornerDrawing key={id} view={v} active={id === activeCorner} onOpen={() => open(id)} wheelbase={model.wheelbase} />;
        })}
      </group>
      {/* World-space results */}
      {vis.patch && CORNER_IDS.map((id) => {
        const patch = model.corners[id]?.patch;
        return patch?.inContact ? <PatchMesh key={id} outline={patch.outline} centroid={patch.centroid!} color={COLORS.patch} /> : null;
      })}
      <ForceArrows arrows={arrows} />
      {vis.arb && <AntiRollBars model={model} />}
      {measureMode && <VehicleMeasurePicks model={model} />}
      <VehicleMeasure model={model} />
      {vis.cg && model.sprungCgWorld && <Joint p={model.sprungCgWorld} color="#ffffff" r={16} />}
      {vis.rollCenter && rcF && rcR && (
        <>
          <Joint p={vec3(rcF.x, rcF.y, 0)} color={COLORS.rc} r={10} />
          <Joint p={vec3(rcR.x, rcR.y, -model.wheelbase)} color={COLORS.rc} r={10} />
          <Seg a={vec3(rcF.x, rcF.y, 250)} b={vec3(rcR.x, rcR.y, -model.wheelbase - 250)} color={COLORS.rc} width={1.5} dashed />
        </>
      )}
    </group>
  );
}

/** A sphere to drag across a horizontal plane in the chassis frame (the plane at its height when grabbed). */
function GroundHandle({ p, color, r, frame, onStart, onDrag, onSelect }: {
  p: Vec3; color: string; r: number; frame: RefObject<THREE.Group | null>;
  onStart: () => boolean; onDrag: (at: { x: number; z: number }) => void;
  /** A click without dragging (e.g. to show its X / Y / Z arrows). */
  onSelect?: () => void;
}) {
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState(false);
  const hit = (ray: THREE.Ray, y: number) => {
    const m = frame.current ? frame.current.matrixWorld.clone().invert() : new THREE.Matrix4();
    const local = ray.clone().applyMatrix4(m);
    const out = new THREE.Vector3();
    return local.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), out) ? { x: out.x, z: out.z } : null;
  };
  return (
    <mesh
      position={[p.x, p.y, p.z]}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!onStart()) return;
        (e.target as unknown as Element).setPointerCapture(e.pointerId);
        drag.current = { y: p.y, moved: false };
        if (controls) controls.enabled = false;
        useApp.getState().set('interacting', true);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        e.stopPropagation();
        const at = hit(e.ray, drag.current.y);
        if (at && (drag.current.moved || Math.hypot(at.x - p.x, at.z - p.z) > r)) { drag.current.moved = true; onDrag(at); }
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        e.stopPropagation();
        (e.target as unknown as Element).releasePointerCapture(e.pointerId);
        const clicked = !drag.current.moved;
        drag.current = null;
        if (controls) controls.enabled = true;
        useApp.getState().set('interacting', false);
        if (clicked) onSelect?.();
      }}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'grab'; }}
      onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}
      onClick={(e) => e.stopPropagation()}
    >
      <sphereGeometry args={[hover ? r * 1.35 : r, 16, 12]} />
      <meshBasicMaterial color={hover ? '#ffffff' : color} depthTest={false} transparent />
    </mesh>
  );
}

const xzDist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/** Where an axle's Ackermann lines end: at their crossing when within reach, else a little past the target. */
export function ackermannEnds(a: AckermannAxle, L: number) {
  const y = a.lines.reduce((s, l) => s + l.t.y, 0) / a.lines.length;
  const near = a.cross && Math.abs(a.cross.z) < 4 * L ? a.cross : null;
  const endZ = near ? near.z : a.target.z + (a.axle === 'front' ? -300 : 300);
  const ends = a.lines.map((l) => {
    const dz = l.t.z - l.k.z;
    const f = Math.abs(dz) > 1e-9 ? (endZ - l.k.z) / dz : 0;
    return vec3(l.k.x + f * (l.t.x - l.k.x), y, endZ);
  });
  return { y, near, ends };
}

/**
 * Classic Ackermann check, top view, for every steered corner: from its steering axis through its
 * steering arm's outer joint, to where an axle's lines cross (or past the target when they don't), with
 * the target marked. Drag a line's handle, or the crossing, to move the outer tie-rod joints: each arm
 * turns about its steering axis (keeping its length). Corners sharing a design move mirrored, so the
 * crossing of a linked pair stays on the centerline.
 */
function AckermannLines({ model, frame }: { model: VehicleModel; frame: RefObject<THREE.Group | null> }) {
  const L = model.wheelbase;
  const start = useRef<{ id: CornerId; root: CornerId; k: Vec3; t: Vec3; axis: [Vec3, Vec3]; design: Vec3 }[]>([]);
  const crossAt = useRef<{ x: number; z: number }>({ x: 0, z: 0 });
  const [selected, setSelected] = useState<'front' | 'rear' | null>(null);
  if (!model.ackermannLines.length) return null;
  /** Record where the arms start (design points); false (with a message) when a joint can't move. */
  const begin = (ids: CornerId[], lead = '') => {
    const s = useApp.getState();
    const all = mergedCorners(s);
    const out: typeof start.current = [];
    for (const a of model.ackermannLines) for (const l of a.lines) {
      if (!ids.includes(l.id)) continue;
      const root = rootOf(l.id, s.links);
      const g = all[root].geom;
      if (([0, 2] as const).some((ax) => pointAxisLocked(s.locks, root, 'trOuter', ax, g.damperArm, g.kind, layoutOf(g), g.steerMechanism, g.steeredAxle))) {
        s.notify(`${l.id}'s outer tie-rod joint is locked (X or Z): unlock it to move it here.`, 'warn');
        return false;
      }
      const p = g.points.trOuter;
      out.push({ id: l.id, root, k: l.k, t: l.t, axis: l.axis, design: vec3(p[0].value, p[1].value, p[2].value) });
    }
    // Corners sharing a design move together, mirrored: say so.
    const shared = CORNER_IDS.filter((c) => out.some((x) => x.root === rootOf(c, s.links) && x.id !== c) && !out.some((x) => x.id === c));
    const also = shared.length ? `${shared.join(', ')} share${shared.length === 1 ? 's' : ''} these dimensions and move${shared.length === 1 ? 's' : ''} with ${shared.length === 1 ? 'it' : 'them'} (a left / right pair mirrored). Untick “same dimensions” (Corner view) to move a corner on its own.` : '';
    if (lead || also) s.notify([lead, also].filter(Boolean).join(' '), 'info');
    // Each design once (a linked pair: the other side follows).
    start.current = out.filter((x, i) => out.findIndex((y) => y.root === x.root) === i);
    return start.current.length > 0;
  };
  /** Turn each started arm about its steering axis so its line passes through `at` (top view). */
  const aim = (at: { x: number; z: number }) => {
    const s = useApp.getState();
    for (const a of start.current) {
      const u0 = { x: a.t.x - a.k.x, z: a.t.z - a.k.z }, len = Math.hypot(u0.x, u0.z);
      let u1 = { x: at.x - a.k.x, z: at.z - a.k.z };
      const n = Math.hypot(u1.x, u1.z);
      if (n < 1 || len < 1e-6) continue;
      u1 = { x: u1.x / n, z: u1.z / n };
      if (u1.x * u0.x + u1.z * u0.z < 0) u1 = { x: -u1.x, z: -u1.z };
      const d = vec3(a.k.x + u1.x * len - a.t.x, 0, a.k.z + u1.z * len - a.t.z);
      const local = placement(a.id, L).dir(d); // mirrored for the right side (its own inverse)
      s.setCornerPoint(a.id, 'trOuter', vec3(Number((a.design.x + local.x).toFixed(4)), a.design.y, Number((a.design.z + local.z).toFixed(4))));
    }
  };
  /**
   * Raise or lower the crossing: the started outer tie-rod joints move up together, and each arm turns
   * about its (inclined) steering axis so its line still passes through the crossing in top view.
   */
  const lift = (dy: number) => {
    const s = useApp.getState();
    const c = crossAt.current;
    for (const a of start.current) {
      const [lo, up] = a.axis, y = a.t.y + dy;
      const f = Math.abs(up.y - lo.y) > 1e-9 ? (y - lo.y) / (up.y - lo.y) : 0;
      const k = vec3(lo.x + f * (up.x - lo.x), y, lo.z + f * (up.z - lo.z));
      const len = Math.hypot(a.t.x - a.k.x, a.t.z - a.k.z);
      let u = { x: c.x - k.x, z: c.z - k.z };
      const n = Math.hypot(u.x, u.z);
      if (n < 1 || len < 1e-6) continue;
      u = { x: u.x / n, z: u.z / n };
      if (u.x * (a.t.x - a.k.x) + u.z * (a.t.z - a.k.z) < 0) u = { x: -u.x, z: -u.z };
      const local = placement(a.id, L).dir(vec3(k.x + u.x * len - a.t.x, dy, k.z + u.z * len - a.t.z));
      s.setCornerPoint(a.id, 'trOuter', vec3(Number((a.design.x + local.x).toFixed(4)), Number((a.design.y + dy).toFixed(4)), Number((a.design.z + local.z).toFixed(4))));
    }
  };
  return (
    <group>
      {model.ackermannLines.map((a) => {
        const { y, near, ends } = ackermannEnds(a, L);
        const s = useApp.getState();
        const pairLinked = a.lines.length === 2 && rootOf(a.lines[0]!.id, s.links) === rootOf(a.lines[1]!.id, s.links);
        return (
          <group key={a.axle}>
            {a.lines.map((l, i) => {
              const e = ends[i]!;
              const handle = add(l.t, scale(sub(e, l.t), 0.35));
              return (
                <group key={l.id}>
                  <Seg a={l.k} b={e} color={COLORS.steering} width={1.5} dashed />
                  {xzDist(e, l.t) > 1 && (
                    <GroundHandle p={vec3(handle.x, y, handle.z)} color={COLORS.steering} r={13} frame={frame}
                      onStart={() => begin([l.id])} onDrag={aim} />
                  )}
                </group>
              );
            })}
            <Joint p={vec3(a.target.x, y, a.target.z)} color="#ffffff" r={9} />
            {near && a.lines.length === 2 && (() => {
              const ids = a.lines.map((l) => l.id);
              const sideways = `The ${a.axle} left and right are mirrored, so their lines cross on the centerline: moving the crossing sideways would make them differ. Untick “${a.axle === 'front' ? 'Front' : 'Rear'} left / right same dimensions” (Corner view) to move it sideways.`;
              const startAt = () => { crossAt.current = { x: near.x, z: near.z }; return begin(ids); };
              return (
                <>
                  <GroundHandle p={vec3(near.x, y, near.z)} color={COLORS.steering} r={16} frame={frame}
                    onStart={() => begin(ids, pairLinked ? 'Dragging keeps the mirrored crossing on the centerline (forward / back only); click it for up / down arrows.' : '')}
                    onDrag={(at) => aim(pairLinked ? { x: 0, z: at.z } : at)}
                    onSelect={() => setSelected(selected === a.axle ? null : a.axle)} />
                  {selected === a.axle && (
                    <AxisGizmo at={vec3(near.x, y, near.z)} frame={frame} axes={[
                      { locked: pairLinked, lockedText: sideways, onStart: startAt, onDelta: (d) => aim({ x: crossAt.current.x + d, z: crossAt.current.z }) },
                      { onStart: startAt, onDelta: lift },
                      { onStart: startAt, onDelta: (d) => aim({ x: crossAt.current.x, z: crossAt.current.z + d }) },
                    ]} />
                  )}
                </>
              );
            })()}
          </group>
        );
      })}
    </group>
  );
}

/** Where a vehicle-view measure pick is, world (null when it can't be found now). */
function vehicleAnchor(model: VehicleModel, id: string): Vec3 | null {
  const r = model.result;
  if (!r) return null;
  const P = poseFns(r.pose);
  if (id === 'cg') return model.sprungCgWorld;
  if (id === 'rcF') return model.rollCenters.front ? vec3(model.rollCenters.front.x, model.rollCenters.front.y, 0) : null;
  if (id === 'rcR') return model.rollCenters.rear ? vec3(model.rollCenters.rear.x, model.rollCenters.rear.y, -model.wheelbase) : null;
  const [c, key] = id.split('.') as [CornerId, string];
  if (!CORNER_IDS.includes(c)) return null;
  if (key === 'contact') return r.corners[c].contact;
  const v = model.corners[c];
  const q = v?.state.points[STATE_KEY[key as PointKey]] as Vec3 | undefined;
  return q ? P.point(placement(c, model.wheelbase).point(q)) : null;
}

const anchorName = (id: string) => {
  if (id === 'cg') return 'CG (sprung)';
  if (id === 'rcF') return 'Roll center, front';
  if (id === 'rcR') return 'Roll center, rear';
  const [c, key] = id.split('.');
  return key === 'contact' ? `${c} contact` : (POINT_NAMES[key as PointKey] ?? key).replace(/^FL_/, `${c}_`);
};

/** The vehicle-view measurement: distance and ΔX/ΔY/ΔZ (vehicle axes) between two picks, live. */
function VehicleMeasure({ model }: { model: VehicleModel }) {
  const m = useApp((s) => s.vehicleMeasure);
  const disp = useDisplay();
  const [a, b] = m.map((id) => vehicleAnchor(model, id));
  if (!a) return null;
  if (!b) return <Joint p={a} color="#ffffff" r={13} />;
  const d = sub(b, a);
  const mid = add(a, scale(d, 0.5));
  return (
    <group>
      <Seg a={a} b={b} color="#ffffff" width={2} />
      <Joint p={a} color="#ffffff" r={10} />
      <Joint p={b} color="#ffffff" r={10} />
      <Html position={[mid.x, mid.y, mid.z]} style={{ pointerEvents: 'none' }}>
        <div className="measure-label">
          <b>{disp.format(Math.hypot(d.x, d.y, d.z), 'mm', 1)}</b>
          <div>ΔX {disp.format(d.x, 'mm', 1)} · ΔY {disp.format(d.y, 'mm', 1)} · ΔZ {disp.format(d.z, 'mm', 1)}</div>
          <div className="muted">{anchorName(m[0]!)} → {anchorName(m[1]!)}</div>
        </div>
      </Html>
    </group>
  );
}

/** A clickable point in the vehicle view: selects it for moving, or adds it to the measurement. */
function VPick({ p, color, r, onPick }: { p: Vec3; color: string; r: number; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <mesh
      position={[p.x, p.y, p.z]}
      onClick={(e) => { e.stopPropagation(); onPick(); }}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}
    >
      <sphereGeometry args={[hover ? r * 1.4 : r, 14, 10]} />
      <meshBasicMaterial color={hover ? '#ffffff' : color} depthTest={false} transparent opacity={0.9} />
    </mesh>
  );
}

/**
 * Every corner's hardpoints, pickable (in the posed chassis frame): click to make that corner active and
 * select the point; the gizmo then moves it. With 📏 Measure on, clicks pick measure points instead.
 */
function VehiclePoints({ model, frame }: { model: VehicleModel; frame: RefObject<THREE.Group | null> }) {
  const measureMode = useApp((s) => s.measureMode);
  const selection = useApp((s) => s.selection);
  const active = useApp((s) => s.activeCorner);
  const vis = useApp((s) => s.visibility);
  const designs = useApp(useShallow((s) => ({ geom: s.geom, corners: s.corners, links: s.links, activeCorner: s.activeCorner })));
  const all = mergedCorners(designs as never);
  const L = model.wheelbase;
  const pick = (id: CornerId, key: PointKey) => {
    const s = useApp.getState();
    if (s.measureMode) { s.addVehicleMeasure(`${id}.${key}`); return; }
    if (s.activeCorner !== id) s.setActiveCorner(id);
    useApp.getState().select({ kind: 'point', id: key });
  };
  const sel = !measureMode && selection?.kind === 'point' ? selection.id : null;
  const v = model.corners[active];
  const selAt = sel && v ? (v.state.points[STATE_KEY[sel]] as Vec3 | undefined) : undefined;
  const mirrored = !isLeft(active);
  return (
    <group>
      {CORNER_IDS.map((id) => {
        const cv = model.corners[id];
        if (!cv) return null;
        const g = all[rootOf(id, designs.links)].geom;
        const keys = activePointKeys(g.kind ?? 'doubleWishbone', layoutOf(g), g.steerMechanism ?? 'rack', g.steeredAxle);
        const pl = placement(id, L);
        return keys.map((k) => {
          const q = cv.state.points[STATE_KEY[k]] as Vec3 | undefined;
          if (!q || (k === 'wheelCenter' && !vis.wheel)) return null;
          return <VPick key={`${id}-${k}`} p={pl.point(q)} color={id === active ? '#ffd166' : '#8a93a3'} r={id === active ? 8 : 6} onPick={() => pick(id, k)} />;
        });
      })}
      {sel && selAt && (
        <VehicleMoveGizmo
          ids={[sel]} at={placement(active, L).point(selAt)} frame={frame} mirrored={mirrored}
          onStart={() => {
            const s = useApp.getState();
            const root = rootOf(active, s.links);
            const shared = CORNER_IDS.filter((c) => c !== active && rootOf(c, s.links) === root);
            if (shared.length) s.notify(`${shared.join(', ')} share${shared.length === 1 ? 's' : ''} ${active}'s dimensions and move${shared.length === 1 ? 's' : ''} with it (a left / right pair mirrored). Untick “same dimensions” (Corner view) to move ${active} on its own.`, 'info');
          }}
        />
      )}
    </group>
  );
}

/** Measure picks that aren't hardpoints: the contact patches, CG and roll centers (world). */
function VehicleMeasurePicks({ model }: { model: VehicleModel }) {
  const add2 = useApp((s) => s.addVehicleMeasure);
  const r = model.result;
  if (!r) return null;
  return (
    <group>
      {CORNER_IDS.map((id) => <VPick key={id} p={r.corners[id].contact} color={COLORS.patch} r={9} onPick={() => add2(`${id}.contact`)} />)}
      {(['cg', 'rcF', 'rcR'] as const).map((id) => { const q = vehicleAnchor(model, id); return q ? <VPick key={id} p={q} color="#ffffff" r={10} onPick={() => add2(id)} /> : null; })}
    </group>
  );
}

interface OverlayLabel { key: string; text: string; pos: Vec3; className?: string }

/** Screen-space labels for the vehicle view (positions follow the 3D points every frame). */
function overlayLabels(model: VehicleModel | null, arrows: ForceArrow[], showValues: boolean, k: number, vis: Record<VisKey, boolean>, active: CornerId): OverlayLabel[] {
  if (!model?.result) return [];
  const out: OverlayLabel[] = showValues
    ? arrows.map((a) => ({ key: a.key, text: a.label, pos: add(a.from, scale(a.vec, k)), className: a.kind }))
    : [];
  const P = poseFns(model.result.pose);
  const L = model.wheelbase;
  const mark = (key: string, text: string, pos: Vec3) => out.push({ key, text, pos, className: 'cg' });
  // Labels: one switch, and each label only with its item.
  if (vis.labels) {
    if (vis.cg && model.sprungCgWorld) mark('cg', 'CG (sprung)', model.sprungCgWorld);
    const rcF = model.rollCenters.front, rcR = model.rollCenters.rear;
    if (vis.rollCenter && rcF && rcR) {
      mark('rcF', 'Roll center, front', vec3(rcF.x, rcF.y, 0));
      mark('rcR', 'Roll center, rear', vec3(rcR.x, rcR.y, -L));
    }
    if (vis.ackermann) {
      for (const a of model.ackermannLines) {
        const { y, near } = ackermannEnds(a, L);
        mark(`ackT-${a.axle}`, `${a.target.label} (100 % Ackermann, ${a.axle})`, P.point(vec3(a.target.x, y, a.target.z)));
        if (near && a.lines.length === 2) mark(`ackX-${a.axle}`, `Ackermann lines cross, ${a.axle} (drag)`, P.point(vec3(near.x, y, near.z)));
      }
    }
    if (vis.arb) {
      for (const [l, r, name] of [['FL', 'FR', 'front'], ['RL', 'RR', 'rear']] as const) {
        const a = model.corners[l]?.dropLink, b = model.corners[r]?.dropLink;
        if (a && b) mark(`arb-${name}`, `Anti-roll bar links, ${name}`, P.point(placement(l, L).point(a)));
      }
    }
  }
  // Ball joints of the active corner (the dots on each corner) with Point labels on.
  const v = model.corners[active];
  if (vis.labels && v && v.state.kind !== 'custom') {
    const pl = placement(active, L), p = v.state.points;
    if (v.state.kind !== 'macpherson' && (vis.uca || vis.upright)) mark('ubj', `${active} upper ball joint`, P.point(pl.point(p.ucaOut)));
    if (vis.lca || vis.upright) mark('lbj', `${active} lower ball joint`, P.point(pl.point(p.lcaOut)));
  }
  return out;
}

/** Toggle which forces are drawn, their size, and their values. */
function ForceToggles() {
  const vis = useApp((s) => s.forceVis);
  const k = useApp((s) => s.forceScale);
  const showValues = useApp((s) => s.forceValues);
  const set = useApp((s) => s.set);
  return (
    <details className="force-toggles" open>
      <summary>Forces</summary>
      {FORCE_KEYS.map((key) => (
        <label key={key} className="check-inline" title={FORCE_META[key].hint}>
          <input type="checkbox" checked={vis[key]} onChange={() => set('forceVis', { ...vis, [key]: !vis[key] })} />
          <span className="swatch" style={{ background: FORCE_META[key].color }} />
          {FORCE_META[key].label}
        </label>
      ))}
      <label className="check-inline">
        <input type="checkbox" checked={showValues} onChange={() => set('forceValues', !showValues)} /> Show values
      </label>
      <label className="force-scale">
        Size
        <input type="range" min={0.02} max={0.4} step={0.01} value={k} onChange={(e) => set('forceScale', Number(e.target.value))} />
      </label>
    </details>
  );
}

/** Inside the Canvas: projects each label's 3D point and moves its DOM element (no React re-render). */
function LabelSync({ labels, layer }: { labels: OverlayLabel[]; layer: RefObject<HTMLDivElement | null> }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const el = layer.current;
    if (!el) return;
    labels.forEach((l, i) => {
      const node = el.children[i] as HTMLElement | undefined;
      if (!node) return;
      v.set(l.pos.x, l.pos.y, l.pos.z).project(camera);
      const visible = v.z > -1 && v.z < 1;
      node.style.display = visible ? '' : 'none';
      node.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, -130%)`;
    });
  });
  return null;
}

function vehicleTarget(model: VehicleModel | null): FocusTarget {
  if (!model?.result) return null;
  const box = new THREE.Box3();
  for (const id of CORNER_IDS) {
    const c = model.result.corners[id];
    box.expandByPoint(new THREE.Vector3(c.contact.x, c.contact.y, c.contact.z));
    box.expandByPoint(new THREE.Vector3(c.wheelCenter.x, c.wheelCenter.y + 300, c.wheelCenter.z));
  }
  const s = box.getBoundingSphere(new THREE.Sphere());
  return { center: vec3(s.center.x, s.center.y, s.center.z), radius: s.radius };
}

export function VehicleViewport({ model }: { model: VehicleModel | null }) {
  const projection = useApp((s) => s.projection);
  const bg = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue('--viewport-bg').trim() || '#16191e', []);
  const target = vehicleTarget(model);
  const vis = useApp((s) => s.forceVis);
  const k = useApp((s) => s.forceScale);
  const showValues = useApp((s) => s.forceValues);
  const arrows = useMemo(() => forceList(model ?? ({} as VehicleModel)).filter((a) => vis[a.kind]), [model, vis]);
  const visAll = useApp((s) => s.visibility);
  const active = useApp((s) => s.activeCorner);
  const labels = useMemo(() => overlayLabels(model, arrows, showValues, k, visAll, active), [model, arrows, showValues, k, visAll, active]);
  const layer = useRef<HTMLDivElement>(null);
  const onMiddle = useMiddleDoubleClick();
  // Force labels are written in N; show them in the display force unit.
  const disp = useDisplay();
  const forceText = (t: string) => t.replace(/(-?\d+(?:\.\d+)?) N\b/g, (_, n: string) => disp.format(Number(n), 'N', 0));
  return (
    <div className="viewport" onMouseDown={onMiddle}>
      <Canvas key={projection} dpr={[1, 2]} style={{ position: 'absolute', inset: 0 }}
        onPointerMissed={(e) => { const s = useApp.getState(); if (e.type === 'click' && !s.measureMode) s.select(null); }}>
        <color attach="background" args={[bg]} />
        {projection === 'orthographic'
          ? <OrthographicCamera makeDefault position={[0, 300, 8000]} zoom={0.3} near={1} far={200000} />
          : <PerspectiveCamera makeDefault position={[0, 300, 6000]} fov={30} near={1} far={200000} />}
        <CameraRig target={target} />
        <DevProjectBridge />
        {model && <VehicleScene model={model} arrows={arrows} />}
        <LabelSync labels={labels} layer={layer} />
      </Canvas>
      <div className="label-layer" ref={layer}>
        {labels.map((l) => <div key={l.key} className={`load-label floating ${l.className ?? ''}`}>{forceText(l.text)}</div>)}
      </div>
      <ViewButtons />
      <ForceToggles />
      <div className="viewport-hint">Click a joint to move it (linked corners move mirrored) · 📏 Measure between any points · double-click a corner to edit it in the Corner view · arrows start where each force acts</div>
      {model?.error && <div className="viewport-error">{model.error}</div>}
    </div>
  );
}

