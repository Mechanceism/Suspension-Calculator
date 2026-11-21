/**
 * Mini X/Y/Z axes at the selected joint. Drag an arrow to move the joint along that axis
 * (snapping to the grid when enabled). The arrows keep a constant size on screen.
 */
import { useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { Vec3 } from '../../core/math/vec3';
import { useApp, type PointKey } from '../store';
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

function Arrow({ axis, origin, id }: { axis: 0 | 1 | 2; origin: THREE.Vector3; id: PointKey }) {
  const { label, color, dir } = AXES[axis];
  const controls = useThree((s) => s.controls) as unknown as Controls;
  const [hover, setHover] = useState(false);
  const drag = useRef<{ t0: number; start: number; origin: THREE.Vector3 } | null>(null);
  const quat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir), [dir]);
  const active = hover || drag.current !== null;

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const t0 = axisParam(e.ray, origin, dir);
    if (t0 === null) return;
    (e.target as unknown as Element).setPointerCapture(e.pointerId);
    const s = useApp.getState();
    drag.current = { t0, start: s.geom.points[id][axis].value, origin: origin.clone() };
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
    let v = d.start + (t - d.t0);
    if (s.snapToGrid && s.gridSize > 0) v = Math.round(v / s.gridSize) * s.gridSize;
    if (Math.abs(v - s.geom.points[id][axis].value) > 1e-9) s.setPointAxis(id, axis, Number(v.toFixed(6)));
  };
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return;
    e.stopPropagation();
    (e.target as unknown as Element).releasePointerCapture(e.pointerId);
    drag.current = null;
    if (controls) controls.enabled = true;
    useApp.getState().set('interacting', false);
  };

  return (
    <group quaternion={quat}>
      <group
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'grab'; }}
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
      <Html position={[0, 1.18, 0]} center style={{ pointerEvents: 'none' }}>
        <span className="gizmo-label" style={{ color }}>{label}</span>
      </Html>
    </group>
  );
}

export function JointGizmo({ id, cur }: { id: PointKey; cur: Current }) {
  const pos = cur.state.points[STATE_KEY[id]] as Vec3 | undefined;
  const group = useRef<THREE.Group>(null);
  const origin = useMemo(() => new THREE.Vector3(), []);
  if (pos) origin.set(pos.x, pos.y, pos.z);

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

  if (!pos) return null;
  return (
    <group ref={group} position={[pos.x, pos.y, pos.z]} renderOrder={10}>
      <mesh>
        <sphereGeometry args={[0.09, 16, 12]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} />
      </mesh>
      {([0, 1, 2] as const).map((a) => <Arrow key={a} axis={a} origin={origin} id={id} />)}
    </group>
  );
}
