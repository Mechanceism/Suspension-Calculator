import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { CameraControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { MeasurePanel } from '../panels/MeasurePanel';
import { useApp, type FocusKey, type ViewName } from '../store';
import type { Model } from '../useModel';
import type { Vec3 } from '../../core/math/vec3';
import { Scene } from './Scene';
import { cornerFrame, lastCamera, recallView, rememberView, sameFrame } from './cameraMemory';
import { Local } from '../panels/UnitText';

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
  const trail = s.kind === 'twistBeam' || s.kind === 'beamLeaf';
  const cpts = s.kind === 'custom' ? (p.customJoints ?? []).flatMap((j) => j.pts) : [];
  const top = { x: p.wheelCenter.x, y: p.wheelCenter.y + radius, z: p.wheelCenter.z };
  const groups: Record<FocusKey, Vec3[]> = s.kind === 'custom' ? {
    corner: [...cpts, p.contact, top], wheel: [p.wheelCenter, p.contact, top], upright: [p.wheelCenter, ...cpts], uca: cpts, lca: cpts,
    tieRod: cpts, rack: cpts, chassis: cpts, spring: p.damperChassis && p.damperArm ? [p.damperChassis, p.damperArm] : [p.wheelCenter], contact: [p.contact],
  } : trail ? {
    corner: [p.lcaFwd, p.lcaAft, p.lcaOut, p.contact, top], wheel: [p.wheelCenter, p.contact, top],
    upright: [p.lcaOut, p.wheelCenter], uca: [p.lcaOut], lca: [p.lcaFwd, p.lcaAft, p.lcaOut], tieRod: [p.wheelCenter], rack: [p.wheelCenter],
    chassis: [p.lcaFwd, p.lcaAft], spring: p.damperChassis && p.damperArm ? [p.damperChassis, p.damperArm] : [p.lcaOut], contact: [p.contact],
  } : {
    corner: [...(s.kind === 'macpherson' ? [p.steerUpper] : s.kind === 'rigid' || s.kind === 'singleArm' ? [p.ucaOut] : [p.ucaFwd, p.ucaAft, p.ucaOut]), ...(s.kind === 'rigid' ? [] : [p.lcaFwd, p.lcaAft]), p.lcaOut, p.trInner, p.trOuter, p.contact,
      { x: p.wheelCenter.x, y: p.wheelCenter.y + radius, z: p.wheelCenter.z }],
    wheel: [p.wheelCenter, p.contact, { x: p.wheelCenter.x, y: p.wheelCenter.y + radius, z: p.wheelCenter.z }],
    upright: [p.steerUpper, p.lcaOut, p.trOuter, p.wheelCenter, ...(p.ucaOut2 ? [p.ucaOut2] : []), ...(p.lcaOut2 ? [p.lcaOut2] : [])],
    uca: s.kind === 'macpherson' ? [p.steerUpper] : [p.ucaFwd, p.ucaAft, p.ucaOut, ...(p.ucaOut2 ? [p.ucaOut2] : [])],
    lca: [p.lcaFwd, p.lcaAft, p.lcaOut, ...(p.lcaOut2 ? [p.lcaOut2] : [])],
    tieRod: [p.trInner, p.trOuter],
    rack: [p.trInner],
    chassis: s.kind === 'singleArm' ? [p.lcaFwd, p.lcaAft] : s.kind === 'rigid' ? [p.ucaOut, p.lcaOut] : s.kind === 'macpherson' ? [p.steerUpper, p.lcaFwd, p.lcaAft] : [p.ucaFwd, p.ucaAft, p.lcaFwd, p.lcaAft],
    spring: p.damperChassis && p.damperArm ? [p.damperChassis, p.damperArm] : [p.wheelCenter],
    contact: [p.contact],
  };
  const box = new THREE.Box3();
  for (const q of groups[focus]) box.expandByPoint(new THREE.Vector3(q.x, q.y, q.z));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z }, radius: Math.max(sphere.radius, 80) };
}

export type FocusTarget = { center: Vec3; radius: number } | null;

/**
 * Camera controls with standard views, fit-to-target and optional follow. Each view (`memoryKey`) remembers
 * its camera: on being shown (`active`) the camera starts where the last view's camera was around the car
 * (`frame` maps this view's coordinates to / from the vehicle frame) and sweeps to where this view was left,
 * or to its default (Iso, fitted) the first time — or where `fallbackKey` was left (Vehicle and Tests static
 * show the same car, so the first visit to one keeps the other's camera).
 * The opening runs on the view's first drawn frames: one to jump to the last camera, then — once frames come
 * steadily (a view being shown can stall a few frames while it catches up, and the controls would cover a
 * stalled frame's whole step at once, cutting the sweep short) — the sweep.
 */
export function CameraRig({ target, memoryKey, fallbackKey, frame = sameFrame, active = true }: {
  target: FocusTarget; memoryKey: string; fallbackKey?: string; active?: boolean;
  frame?: { toVehicle: (v: THREE.Vector3) => THREE.Vector3; fromVehicle: (v: THREE.Vector3) => THREE.Vector3 };
}) {
  const controls = useRef<ComponentRef<typeof CameraControls>>(null);
  // CameraControls is rebuilt when the default camera changes, so view requests re-apply then too.
  const camera = useThree((s) => s.camera);
  const request = useApp((s) => s.cameraRequest);
  const follow = useApp((s) => s.followFocus);
  const targetRef = useRef(target);
  targetRef.current = target;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  // The request seen when this view was shown: only newer ones (a button pressed here) move the camera.
  const openedAt = useRef(request.nonce);
  // Opening steps: 'jump' (to the last camera), 'sweep' (to this view's own), then remembering each frame.
  const phase = useRef<'off' | 'jump' | 'settle' | 'sweep' | 'on'>('off');
  const settle = useRef({ smooth: 0, waited: 0 });
  const hasTarget = !!target;
  // Before the first frame is drawn (a layout effect), so it never shows this view's old camera first.
  useLayoutEffect(() => {
    if (!active) { phase.current = 'off'; return; }
    if (!hasTarget || phase.current === 'on') return;
    openedAt.current = useApp.getState().cameraRequest.nonce;
    phase.current = 'jump';
  }, [active, camera, hasTarget]);
  const fit = (c: NonNullable<typeof controls.current>, t: NonNullable<FocusTarget>, animate: boolean) =>
    void c.fitToSphere(new THREE.Sphere(new THREE.Vector3(t.center.x, t.center.y, t.center.z), t.radius * 1.15), animate);

  // Standard view / refocus requests made while this view is shown.
  useEffect(() => {
    const c = controls.current;
    const t = targetRef.current;
    if (!active || !c || !t || request.nonce === openedAt.current) return;
    if (request.view) {
      const v = VIEWS[request.view];
      void c.rotateTo(v.azimuth, v.polar, true);
    }
    fit(c, t, true);
  }, [request.nonce, request.view, camera]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock the camera to the focused component as it moves. Done every frame, just before rendering,
  // so the camera and the parts move together (an effect after the render made it stutter).
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const pose = useMemo(() => ({ pos: new THREE.Vector3(), target: new THREE.Vector3() }), []);
  const from = useRef<ReturnType<typeof lastCamera>>(null);
  useFrame((_, delta) => {
    const c = controls.current;
    const t = targetRef.current;
    if (!c) return;
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera;
    if (phase.current === 'jump' && t) {
      from.current = lastCamera(frameRef.current.fromVehicle);
      const f = from.current;
      if (f) {
        void c.setLookAt(f.pos.x, f.pos.y, f.pos.z, f.target.x, f.target.y, f.target.z, false);
        if (ortho && f.zoom) void c.zoomTo(f.zoom, false);
        c.update(0);
        phase.current = 'settle';
        settle.current = { smooth: 0, waited: 0 };
        return;
      }
      phase.current = 'sweep'; // the first view shown: straight to its own camera, no sweep
    }
    if (phase.current === 'settle') {
      // Five steady frames in a row (or 1.2 s at most), then sweep.
      settle.current.waited += delta;
      settle.current.smooth = delta < 0.05 ? settle.current.smooth + 1 : 0;
      if (settle.current.smooth < 5 && settle.current.waited < 1.2) return;
      phase.current = 'sweep';
    }
    if (phase.current === 'sweep' && t) {
      const animate = !!from.current;
      const to = recallView(memoryKey) ?? (fallbackKey ? recallView(fallbackKey) : null);
      if (to) {
        void c.setLookAt(to.pos.x, to.pos.y, to.pos.z, to.target.x, to.target.y, to.target.z, animate);
        if (ortho && to.zoom) void c.zoomTo(to.zoom, animate);
      } else {
        const v = VIEWS[useApp.getState().cameraRequest.view ?? 'iso'];
        void c.rotateTo(v.azimuth, v.polar, animate);
        fit(c, t, animate);
      }
      if (!animate) c.update(0);
      phase.current = 'on';
    }
    // Remember where this view's camera is (where it's heading, mid-sweep).
    if (phase.current === 'on') {
      c.getPosition(pose.pos, true);
      c.getTarget(pose.target, true);
      rememberView(memoryKey, { ...pose, zoom: ortho ? camera.zoom : undefined }, frameRef.current.toVehicle);
    }
    if (!follow || !t) return;
    c.getTarget(tmp);
    const dx = t.center.x - tmp.x, dy = t.center.y - tmp.y, dz = t.center.z - tmp.z;
    if (dx * dx + dy * dy + dz * dz < 1e-6) return;
    // Shift camera and target together so the view direction and zoom stay put.
    c.getPosition(tmp);
    void c.setLookAt(tmp.x + dx, tmp.y + dy, tmp.z + dz, t.center.x, t.center.y, t.center.z, false);
    c.update(0);
  }, -2);

  return <CameraControls ref={controls} makeDefault smoothTime={0.25} />;
}

/** Dev only: lets automated UI checks turn a 3D point into screen pixels (window.__project). */
export function DevProjectBridge() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const project = useMemo(() => (x: number, y: number, z: number): [number, number] => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    const r = gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * size.width, r.top + ((1 - v.y) / 2) * size.height];
  }, [camera, size, gl]);
  // Set while this view draws (several views stay mounted; only the one shown draws frames).
  useFrame(() => {
    if (!import.meta.env.DEV && !window.location.search.includes('debug')) return;
    (window as unknown as { __project?: typeof project }).__project = project;
  });
  return null;
}

/**
 * Double middle-click anywhere in a viewport: fit everything in view. (Browsers fire no dblclick for
 * the middle button, so two middle presses within 400 ms count.)
 */
export function useMiddleDoubleClick() {
  const last = useRef(0);
  return (e: { button: number; preventDefault: () => void }) => {
    if (e.button !== 1) return;
    e.preventDefault(); // no auto-scroll
    const t = performance.now();
    if (t - last.current < 400) { useApp.getState().focusOn('corner'); last.current = 0; }
    else last.current = t;
  };
}

export function ViewButtons({ measure = true }: { measure?: boolean }) {
  const requestView = useApp((s) => s.requestView);
  const focusOn = useApp((s) => s.focusOn);
  const projection = useApp((s) => s.projection);
  const set = useApp((s) => s.set);
  const measureMode = useApp((s) => s.measureMode);
  const toggleMeasure = useApp((s) => s.toggleMeasure);
  return (
    <div className="view-buttons">
      {measure && <button className={measureMode ? 'toggle on' : 'toggle'} onClick={toggleMeasure} title="Measure between two points (M)">📏 Measure</button>}
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
      <button onClick={() => focusOn('corner')} title="Fit everything in view (or double middle-click)">⤢ Fit</button>
    </div>
  );
}

export function Viewport({ model, active = true }: { model: Model; active?: boolean }) {
  const projection = useApp((s) => s.projection);
  const measureMode = useApp((s) => s.measureMode);
  const measureCount = useApp((s) => s.measure.length);
  const select = useApp((s) => s.select);
  const focus = useApp((s) => s.focus);
  const radius = useApp((s) => s.geom.scalars.tireDiameter.value / 2);
  const target = focusSphere(model, focus, radius);
  const corner = useApp((s) => s.activeCorner);
  const wheelbase = useApp((s) => s.vehicle.wheelbase.value);
  const frame = useMemo(() => cornerFrame(corner, wheelbase), [corner, wheelbase]);
  const bg = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue('--viewport-bg').trim() || '#16191e', []);
  const onMiddle = useMiddleDoubleClick();
  return (
    <div className="viewport" onMouseDown={onMiddle}>
      <Canvas
        key={projection} dpr={[1, 2]} style={{ position: 'absolute', inset: 0 }} frameloop={active ? 'always' : 'never'}
        onPointerMissed={(e) => { if (e.type === 'click' && !measureMode) select(null); }}
      >
        <color attach="background" args={[bg]} />
        {projection === 'orthographic'
          ? <OrthographicCamera makeDefault position={[300, 150, 5000]} zoom={0.6} near={1} far={100000} />
          : <PerspectiveCamera makeDefault position={[300, 150, 3500]} fov={30} near={1} far={100000} />}
        <CameraRig target={target} memoryKey="corner" frame={frame} active={active} />
        <DevProjectBridge />
        <Scene model={model} />
      </Canvas>
      <ViewButtons />
      {measureMode && (
        <div className="viewport-banner">
          {measureCount < 2 ? `Measure: click ${measureCount === 0 ? 'the first' : 'the second'} point` : 'Click another point to start a new measurement'}
          <button className="banner-btn" onClick={() => useApp.getState().toggleMeasure()} title="Leave the measure tool (Esc)">Cancel</button>
        </div>
      )}
      {measureMode && measureCount === 2 && <MeasurePanel cur={model.current} />}
      {model.error && <div className="viewport-error"><Local text={model.error} /></div>}
    </div>
  );
}
