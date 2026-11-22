/**
 * Mini X/Y/Z axes for moving hardpoints. Shown at a selected joint, or at the center of a selected
 * part / multi-selection, where dragging moves every selected point by the same amount.
 * Drag an arrow to move along that axis (the move snaps to the grid when enabled). The arrows keep a
 * constant size on screen, and updates are limited to one per frame so dragging stays smooth.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '../../core/math/vec3';
import { layoutOf, useApp, rootOf, type PointKey } from '../store';
import { pointAxisLocked } from '../locks';
import { STATE_KEY } from '../anchors';
import type { Current } from '../useModel';

const AXES = [
  { label: 'X', color: '#ff5c5c', dir: new THREE.Vector3(1, 0, 0) },
  { label: 'Y', color: '#5cdc6a', dir: new THREE.Vector3(0, 1, 0) },
  { label: 'Z', color: '#5c9dff', dir: new THREE.Vector3(0, 0, 1) },
] as const;
const SCREEN_PX = 70;

/** Parameter t along the axis line (origin o, unit dir u) closest to the ray. */
function axisParam(ray: THREE.Ray, o: THREE.Vector3, u: THREE.Vector3): number | null {
  const w = o.clone().sub(ray.origin);
  const b = u.dot(ray.direction);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null; // looking straight down the axis
  return (b * ray.direction.dot(w) - u.dot(w)) / denom;
}

type Controls = { enabled: boolean } | null;

/**
 * Axis letter drawn as a sprite (a canvas texture), not a DOM label: the gizmo mounts and unmounts
 * with the selection, and DOM labels (separate React roots) can't unmount cleanly mid-render.
 */
function AxisLabel({ text, color }: { text: string; color: string }) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 48;
    const g = c.getContext('2d');
    if (g) {
      g.font = 'bold 30px ui-monospace, Consolas, monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 5; g.strokeStyle = 'rgba(22, 25, 30, 0.85)';
      g.strokeText(text, 64, 25);
      g.fillStyle = color;
      g.fillText(text, 64, 25);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [text, color]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <sprite position={[0, 1.2, 0]} scale={[0.6, 0.225, 1]} renderOrder={10}>
      <spriteMaterial map={tex} depthTest={false} transparent />
    </sprite>
  );
}

/**
 * One drag arrow. Along a coordinate axis (`axis`) it moves that coordinate of every id; along a
 * `line` (any direction) it slides one joint along that direction, changing X, Y and Z together.
 */
function Arrow({ axis, line, origin, ids, locked }: {
  axis?: 0 | 1 | 2; line?: { dir: THREE.Vector3; label: string }; origin: THREE.Vector3; ids: PointKey[]; locked: boolean;
}) {
  const label = line ? line.label : AXES[axis!].label;
  const dir = line ? line.dir : AXES[axis!].dir;
  const color = locked ? '#5b616d' : line ? '#ffd166' : AXES[axis!].color;
  const controls = useThree((s) => s.controls) as unknown as Controls;
  const [hover, setHover] = useState(false);
  const drag = useRef<{ t0: number; starts: number[]; origin: THREE.Vector3; pending: number | null; raf: number } | null>(null);
  const quat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir), [dir]);

  const flush = () => {
    const d = drag.current;
    if (!d || d.pending === null) return;
    const delta = d.pending;
    d.pending = null;
    d.raf = 0;
    if (line) {
      const k = ids[0]!;
      const v = [dir.x, dir.y, dir.z];
      useApp.getState().setPointsAxis(([0, 1, 2] as const).filter((a) => Math.abs(v[a]!) > 1e-9)
        .map((a) => ({ key: k, axis: a, value: Number((d.starts[a]! + v[a]! * delta).toFixed(6)) })));
      return;
    }
    useApp.getState().setPointsAxis(ids.map((key, i) => ({ key, axis: axis!, value: Number((d.starts[i]! + delta).toFixed(6)) })));
  };

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (locked) { useApp.getState().notify(`${label} is locked for this selection`); return; }
    const t0 = axisParam(e.ray, origin, dir);
    if (t0 === null) return;
    (e.target as unknown as Element).setPointerCapture(e.pointerId);
    const s = useApp.getState();
    const starts = line ? s.geom.points[ids[0]!].map((f) => f.value) : ids.map((k) => s.geom.points[k][axis!].value);
    drag.current = { t0, starts, origin: origin.clone(), pending: null, raf: 0 };
    if (controls) controls.enabled = false;
    s.set('interacting', true);
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const t = axisParam(e.ray, d.origin, dir);
    if (t === null) return;
    const s = useApp.getState();
    let delta = t - d.t0;
    if (s.snapToGrid && s.gridSize > 0) {
      // One point: snap its coordinate to the grid. Several: snap the move, keeping their spacing.
      delta = ids.length === 1 && !line
        ? Math.round((d.starts[0]! + delta) / s.gridSize) * s.gridSize - d.starts[0]!
        : Math.round(delta / s.gridSize) * s.gridSize;
    }
    d.pending = delta;
    if (!d.raf) d.raf = requestAnimationFrame(flush);
  };
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    (e.target as unknown as Element).releasePointerCapture(e.pointerId);
    if (d.raf) cancelAnimationFrame(d.raf);
    flush();
    drag.current = null;
    if (controls) controls.enabled = true;
    useApp.getState().set('interacting', false);
  };

  const active = hover;
  return (
    <group quaternion={quat}>
      <group
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onPointerOver={(e) => { e.stopPropagation(); setHover(!locked); document.body.style.cursor = locked ? 'not-allowed' : 'grab'; }}
        onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}
        onClick={(e) => e.stopPropagation()}
      >
        <mesh position={[0, 0.42, 0]}>
          <cylinderGeometry args={[active ? 0.045 : 0.03, active ? 0.045 : 0.03, 0.84, 8]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={active ? 1 : 0.85} />
        </mesh>
        <mesh position={[0, 0.92, 0]}>
          <coneGeometry args={[active ? 0.11 : 0.085, 0.24, 14]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
        {/* Generous invisible grab area */}
        <mesh position={[0, 0.55, 0]}>
          <cylinderGeometry args={[0.14, 0.14, 1.1, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      </group>
      <AxisLabel text={locked ? `${label} 🔒` : label} color={color} />
    </group>
  );
}

export function MoveGizmo({ ids, cur }: { ids: PointKey[]; cur: Current }) {
  const positions = ids.map((k) => cur.state.points[STATE_KEY[k]] as Vec3 | undefined).filter((p): p is Vec3 => Boolean(p));
  const group = useRef<THREE.Group>(null);
  const origin = useMemo(() => new THREE.Vector3(), []);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const damperArm = useApp((s) => s.geom.damperArm);
  const kind = useApp((s) => s.geom.kind);
  const layout = useApp((s) => layoutOf(s.geom));
  // Point editor's "along the line toward…": an extra (yellow) arrow along that line.
  const lineMove = useApp((s) => s.lineMove);
  const geom = useApp((s) => s.geom);
  const lineArrow = useMemo(() => {
    if (ids.length !== 1 || !lineMove || lineMove.id !== ids[0]) return null;
    const p = geom.points[lineMove.id], q = geom.points[lineMove.toward];
    const d = new THREE.Vector3(q[0].value - p[0].value, q[1].value - p[1].value, q[2].value - p[2].value);
    if (d.lengthSq() < 1e-12) return null;
    return { dir: d.normalize(), label: '→' };
  }, [ids, lineMove, geom]);
  if (positions.length) {
    origin.set(0, 0, 0);
    for (const p of positions) origin.add(new THREE.Vector3(p.x, p.y, p.z));
    origin.multiplyScalar(1 / positions.length);
  }

  // Constant on-screen size.
  useFrame(({ camera, size }) => {
    const g = group.current;
    if (!g) return;
    let mmPerPx: number;
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const c = camera as THREE.OrthographicCamera;
      mmPerPx = (c.top - c.bottom) / c.zoom / size.height;
    } else {
      const c = camera as THREE.PerspectiveCamera;
      const dist = c.position.distanceTo(g.position);
      mmPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2)) / size.height;
    }
    g.scale.setScalar(SCREEN_PX * mmPerPx);
  });

  if (!positions.length) return null;
  return (
    <group ref={group} position={[origin.x, origin.y, origin.z]}>
      <mesh>
        {ids.length > 1 ? <boxGeometry args={[0.16, 0.16, 0.16]} /> : <sphereGeometry args={[0.09, 16, 12]} />}
        <meshBasicMaterial color="#ffffff" depthTest={false} />
      </mesh>
      {([0, 1, 2] as const).map((a) => <Arrow key={a} axis={a} origin={origin} ids={ids} locked={ids.some((k) => pointAxisLocked(locks, root, k, a, damperArm, kind, layout))} />)}
      {lineArrow && (
        <Arrow line={lineArrow} origin={origin} ids={ids}
          locked={([0, 1, 2] as const).some((a) => Math.abs([lineArrow.dir.x, lineArrow.dir.y, lineArrow.dir.z][a]!) > 1e-9 && pointAxisLocked(locks, root, ids[0]!, a, damperArm, kind, layout))} />
      )}
    </group>
  );
}
