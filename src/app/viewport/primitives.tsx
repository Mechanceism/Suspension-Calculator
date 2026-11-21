/** Small reusable 3D pieces. Scene units are mm; axes map 1:1 (X outboard, Y up, Z forward). */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Line, Html } from '@react-three/drei';
import type { Vec3 } from '../../core/math/vec3';

export type V3 = [number, number, number];
export const arr = (v: Vec3): V3 => [v.x, v.y, v.z];

export function Joint({ p, color, r = 7 }: { p: Vec3; color: string; r?: number }) {
  return (
    <mesh position={arr(p)}>
      <sphereGeometry args={[r, 16, 12]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

export function Seg({ a, b, color, width = 2, dashed = false, opacity = 1 }: {
  a: Vec3; b: Vec3; color: string; width?: number; dashed?: boolean; opacity?: number;
}) {
  return (
    <Line
      points={[arr(a), arr(b)]} color={color} lineWidth={width}
      dashed={dashed} dashSize={20} gapSize={12} transparent={opacity < 1} opacity={opacity}
    />
  );
}

export function Polyline({ pts, color, width = 2, opacity = 1, dashed = false }: {
  pts: Vec3[]; color: string; width?: number; opacity?: number; dashed?: boolean;
}) {
  if (pts.length < 2) return null;
  return (
    <Line
      points={pts.map(arr)} color={color} lineWidth={width}
      transparent={opacity < 1} opacity={opacity} dashed={dashed} dashSize={20} gapSize={12}
    />
  );
}

/** Filled triangle whose vertices update in place (no geometry churn while animating). */
export function Tri({ a, b, c, color, opacity = 0.35 }: { a: Vec3; b: Vec3; c: Vec3; color: string; opacity?: number }) {
  const positions = useMemo(() => new Float32Array(9), []);
  const geom = useRef<THREE.BufferGeometry>(null);
  useLayoutEffect(() => {
    positions.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
    const g = geom.current;
    if (!g) return;
    g.getAttribute('position').needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }, [a, b, c, positions]);
  return (
    <mesh>
      <bufferGeometry ref={geom}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <meshStandardMaterial color={color} side={THREE.DoubleSide} transparent opacity={opacity} depthWrite={false} />
    </mesh>
  );
}

const circlePoints = (r: number, y: number, n = 72): V3[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [r * Math.cos(t), y, r * Math.sin(t)];
  });

/**
 * Tire cross-section (radius vs. position across the tread), revolved about the spin axis:
 * sidewall from the rim up, quarter-circle shoulder, flat tread, shoulder, sidewall back down.
 * Same profile as the contact-patch math (docs/MATH.md § L3).
 */
function tireProfile(radius: number, width: number, shoulder: number, rimRadius: number): THREE.Vector2[] {
  const half = width / 2;
  const re = Math.max(0, Math.min(shoulder, half, radius - rimRadius));
  const pts: THREE.Vector2[] = [new THREE.Vector2(rimRadius, -half)];
  const arc = (cy: number, from: number, to: number) => {
    for (let i = 0; i <= 12; i++) {
      const t = from + ((to - from) * i) / 12;
      pts.push(new THREE.Vector2(radius - re + re * Math.cos(t), cy + re * Math.sin(t)));
    }
  };
  if (re > 0) {
    arc(-half + re, -Math.PI / 2, 0); // inboard shoulder: side → tread
    arc(half - re, 0, Math.PI / 2); // outboard shoulder: tread → side
  } else {
    pts.push(new THREE.Vector2(radius, -half), new THREE.Vector2(radius, half));
  }
  pts.push(new THREE.Vector2(rimRadius, half));
  return pts;
}

/** Tire with rounded shoulders, aligned with the spin axis, plus center-plane and tread-edge circles. */
export function Wheel({ center, axis, radius, width, color, ghost = false, shoulder = 0, rimRadius }: {
  center: Vec3; axis: Vec3; radius: number; width: number; color: string; ghost?: boolean;
  shoulder?: number; rimRadius?: number;
}) {
  const quat = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(axis.x, axis.y, axis.z)),
    [axis],
  );
  const rim = rimRadius ?? radius * 0.62;
  const re = Math.max(0, Math.min(shoulder, width / 2, radius - rim));
  const geometry = useMemo(
    () => (ghost ? null : new THREE.LatheGeometry(tireProfile(radius, width, shoulder, rim), 72)),
    [ghost, radius, width, shoulder, rim],
  );
  useEffect(() => () => geometry?.dispose(), [geometry]);
  const mid = useMemo(() => circlePoints(radius, 0), [radius]);
  const outer = useMemo(() => circlePoints(radius, width / 2 - re), [radius, width, re]);
  const inner = useMemo(() => circlePoints(radius, -width / 2 + re), [radius, width, re]);
  const rimOut = useMemo(() => circlePoints(rim, width / 2), [rim, width]);
  const rimIn = useMemo(() => circlePoints(rim, -width / 2), [rim, width]);
  return (
    <group position={arr(center)} quaternion={quat}>
      {geometry && (
        <mesh geometry={geometry}>
          <meshStandardMaterial color={color} transparent opacity={0.16} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      <Line points={mid} color={color} lineWidth={ghost ? 1 : 1.5} transparent opacity={ghost ? 0.35 : 0.9} dashed={!ghost} dashSize={25} gapSize={15} />
      {!ghost && <Line points={outer} color={color} lineWidth={2} />}
      {!ghost && <Line points={inner} color={color} lineWidth={2} />}
      {!ghost && <Line points={rimOut} color={color} lineWidth={1} transparent opacity={0.45} />}
      {!ghost && <Line points={rimIn} color={color} lineWidth={1} transparent opacity={0.45} />}
    </group>
  );
}

/** Invisible, clickable cylinder along a link (thin lines are hard to hit with the mouse). */
export function HitLink({ a, b, radius }: { a: Vec3; b: Vec3; radius: number }) {
  const { position, quaternion, len } = useMemo(() => {
    const A = new THREE.Vector3(a.x, a.y, a.z);
    const B = new THREE.Vector3(b.x, b.y, b.z);
    const dir = B.clone().sub(A);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return { position: A.add(B).multiplyScalar(0.5), quaternion: q, len: dir.length() };
  }, [a, b]);
  return (
    <mesh position={position} quaternion={quaternion}>
      <cylinderGeometry args={[radius, radius, len, 8, 1]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
    </mesh>
  );
}

/** Coilover between two mounts: damper body + shaft, with a helical spring drawn around it. */
export function Coilover({ a, b, color, coils = 9, radius = 26 }: { a: Vec3; b: Vec3; color: string; coils?: number; radius?: number }) {
  const geo = useMemo(() => {
    const A = new THREE.Vector3(a.x, a.y, a.z);
    const B = new THREE.Vector3(b.x, b.y, b.z);
    const axis = B.clone().sub(A);
    const len = axis.length();
    const u = axis.clone().normalize();
    const helper = Math.abs(u.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const e1 = new THREE.Vector3().crossVectors(u, helper).normalize();
    const e2 = new THREE.Vector3().crossVectors(u, e1);
    // Spring occupies the middle 76% of the length (spring seats at 12% from each end).
    const start = 0.12 * len;
    const span = 0.76 * len;
    const n = coils * 24;
    const helix: V3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const ang = t * coils * Math.PI * 2;
      const p = A.clone().addScaledVector(u, start + span * t)
        .addScaledVector(e1, radius * Math.cos(ang)).addScaledVector(e2, radius * Math.sin(ang));
      helix.push([p.x, p.y, p.z]);
    }
    const bodyEnd = A.clone().addScaledVector(u, 0.55 * len);
    return { helix, body: [[A.x, A.y, A.z], [bodyEnd.x, bodyEnd.y, bodyEnd.z]] as V3[], shaft: [[bodyEnd.x, bodyEnd.y, bodyEnd.z], [B.x, B.y, B.z]] as V3[] };
  }, [a, b, coils, radius]);
  return (
    <group>
      <Line points={geo.body} color="#6b7280" lineWidth={9} />
      <Line points={geo.shaft} color="#cbd2dc" lineWidth={3} />
      <Line points={geo.helix} color={color} lineWidth={2} />
    </group>
  );
}

/** Filled contact patch (triangle fan from the centroid) with its outline, lifted slightly off the ground. */
export function PatchMesh({ outline, centroid, color }: { outline: Vec3[]; centroid: Vec3; color: string }) {
  const lift = 0.6;
  const geometry = useMemo(() => {
    const pos: number[] = [];
    for (let i = 0; i + 1 < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[i + 1]!;
      pos.push(centroid.x, centroid.y + lift, centroid.z, a.x, a.y + lift, a.z, b.x, b.y + lift, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, [outline, centroid]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group>
      <mesh geometry={geometry}>
        <meshBasicMaterial color={color} transparent opacity={0.55} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line points={outline.map((q) => [q.x, q.y + lift, q.z] as V3)} color={color} lineWidth={2} />
    </group>
  );
}

export function Label({ p, text }: { p: Vec3; text: string }) {
  return (
    <Html position={arr(p)} style={{ pointerEvents: 'none' }}>
      <div className="scene-label">{text}</div>
    </Html>
  );
}
