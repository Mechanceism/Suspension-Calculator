import { useEffect, useMemo, useRef, type ComponentRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { CameraControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { useApp, type FocusKey, type ViewName } from '../store';
import type { Model } from '../useModel';
import type { Vec3 } from '../../core/math/vec3';
import { Scene } from './Scene';

/** Camera azimuth (about +Y, from +Z toward +X) and polar (from +Y) for each standard view. */
const VIEWS: Record<ViewName, { azimuth: number; polar: number; label: string }> = {
  front: { azimuth: 0, polar: Math.PI / 2, label: 'Front' },
  rear: { azimuth: Math.PI, polar: Math.PI / 2, label: 'Rear' },
  outboard: { azimuth: Math.PI / 2, polar: Math.PI / 2, label: 'Outboard' },
  inboard: { azimuth: -Math.PI / 2, polar: Math.PI / 2, label: 'Inboard' },
  top: { azimuth: Math.PI, polar: 1e-4, label: 'Top' }, // front of vehicle toward screen top
  bottom: { azimuth: 0, polar: Math.PI - 1e-4, label: 'Bottom' },
  iso: { azimuth: Math.PI / 4, polar: Math.PI / 3, label: 'Iso' },
};

function focusSphere(model: Model, focus: FocusKey, radius: number): { center: Vec3; radius: number } | null {
  const s = model.current?.state;
  if (!s) return null;
  const p = s.points;
  const groups: Record<FocusKey, Vec3[]> = {
    corner: [p.ucaFwd, p.ucaAft, p.lcaFwd, p.lcaAft, p.ucaOut, p.lcaOut, p.trInner, p.trOuter, p.contact,
      { x: p.wheelCenter.x, y: p.wheelCenter.y + radius, z: p.wheelCenter.z }],
    wheel: [p.wheelCenter, p.contact, { x: p.wheelCenter.x, y: p.wheelCenter.y + radius, z: p.wheelCenter.z }],
    upright: [p.ucaOut, p.lcaOut, p.trOuter, p.wheelCenter],
    uca: [p.ucaFwd, p.ucaAft, p.ucaOut],
    lca: [p.lcaFwd, p.lcaAft, p.lcaOut],
    tieRod: [p.trInner, p.trOuter],
    contact: [p.contact],
  };
  const box = new THREE.Box3();
  for (const q of groups[focus]) box.expandByPoint(new THREE.Vector3(q.x, q.y, q.z));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z }, radius: Math.max(sphere.radius, 80) };
}

function CameraRig({ model }: { model: Model }) {
  const controls = useRef<ComponentRef<typeof CameraControls>>(null);
  // CameraControls is rebuilt when the default camera changes, so view requests re-apply then too.
  const camera = useThree((s) => s.camera);
  const request = useApp((s) => s.cameraRequest);
  const focus = useApp((s) => s.focus);
  const follow = useApp((s) => s.followFocus);
  const radius = useApp((s) => s.geom.scalars.wheelRadius.value);
  const target = focusSphere(model, focus, radius);
  const targetRef = useRef(target);
  targetRef.current = target;

  // Standard view / refocus requests.
  useEffect(() => {
    const c = controls.current;
    const t = targetRef.current;
    if (!c || !t) return;
    const animate = request.nonce > 0; // snap on first load, animate afterwards
    if (request.view) {
      const v = VIEWS[request.view];
      void c.rotateTo(v.azimuth, v.polar, animate);
    }
    void c.fitToSphere(new THREE.Sphere(new THREE.Vector3(t.center.x, t.center.y, t.center.z), t.radius * 1.15), animate);
  }, [request.nonce, request.view, camera]);

  // Lock the camera to the focused component as it moves.
  const cx = target?.center.x, cy = target?.center.y, cz = target?.center.z;
  useEffect(() => {
    const c = controls.current;
    if (!c || !follow || cx === undefined || cy === undefined || cz === undefined) return;
    void c.moveTo(cx, cy, cz, false);
  }, [follow, cx, cy, cz]);

  return <CameraControls ref={controls} makeDefault smoothTime={0.2} />;
}

export function ViewButtons() {
  const requestView = useApp((s) => s.requestView);
  const projection = useApp((s) => s.projection);
  const set = useApp((s) => s.set);
  return (
    <div className="view-buttons">
      {(Object.keys(VIEWS) as ViewName[]).map((v) => (
        <button key={v} onClick={() => requestView(v)}>{VIEWS[v].label}</button>
      ))}
      <button
        className="toggle"
        onClick={() => set('projection', projection === 'orthographic' ? 'perspective' : 'orthographic')}
        title="Toggle projection"
      >
        {projection === 'orthographic' ? 'Ortho' : 'Persp'}
      </button>
    </div>
  );
}

export function Viewport({ model }: { model: Model }) {
  const projection = useApp((s) => s.projection);
  const bg = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue('--viewport-bg').trim() || '#16191e', []);
  return (
    <div className="viewport">
      <Canvas key={projection} dpr={[1, 2]} style={{ position: 'absolute', inset: 0 }}>
        <color attach="background" args={[bg]} />
        {projection === 'orthographic'
          ? <OrthographicCamera makeDefault position={[300, 150, 5000]} zoom={0.6} near={1} far={100000} />
          : <PerspectiveCamera makeDefault position={[300, 150, 3500]} fov={30} near={1} far={100000} />}
        <CameraRig model={model} />
        <Scene model={model} />
      </Canvas>
      <ViewButtons />
      {model.error && <div className="viewport-error">{model.error}</div>}
    </div>
  );
}
