/**
 * Vehicle viewport (L6): the four corners on the chassis, posed by the solved heave/roll/pitch, with
 * contact patches, tire load / lateral force arrows, the CG and the roll axis. Double-click a corner
 * to edit it in the Corner view.
 */
import { useMemo, useRef, type RefObject } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { switchWorkspace } from './SafeHtml';
import * as THREE from 'three';
import { vec3, add, type Vec3 } from '../../core/math/vec3';
import { closestPointOnLine, lineThrough } from '../../core/math/geom';
import { CORNER_IDS, placement, type CornerId } from '../../core/vehicle/vehicle';
import { useApp } from '../store';
import type { VehicleModel, VehicleCornerView } from '../useVehicle';
import { CameraRig, DevProjectBridge, ViewButtons, type FocusTarget } from './Viewport';
import { COLORS } from './Scene';
import { Joint, Seg, Polyline, Tri, Wheel, PatchMesh, Coilover } from './primitives';

const LOAD_SCALE = 0.12; // mm of arrow per N

/** One corner drawn in the vehicle frame. Right corners are mirrored point-by-point (a negative
 *  scale on the group would flip the line quads' winding and cull them). */
function CornerDrawing({ view, onOpen, active, wheelbase }: { view: VehicleCornerView; onOpen: () => void; active: boolean; wheelbase: number }) {
  const simpleTire = useApp((s) => s.simpleTire);
  const pl = placement(view.id, wheelbase);
  const raw = view.state.points;
  const p = {
    ucaFwd: pl.point(raw.ucaFwd), ucaAft: pl.point(raw.ucaAft), ucaOut: pl.point(raw.ucaOut),
    lcaFwd: pl.point(raw.lcaFwd), lcaAft: pl.point(raw.lcaAft), lcaOut: pl.point(raw.lcaOut),
    trInner: pl.point(raw.trInner), trOuter: pl.point(raw.trOuter), wheelCenter: pl.point(raw.wheelCenter),
    damperChassis: raw.damperChassis ? pl.point(raw.damperChassis) : undefined,
    damperArm: raw.damperArm ? pl.point(raw.damperArm) : undefined,
  };
  const axis = pl.dir(view.state.spinAxis);
  const foot = closestPointOnLine(lineThrough(p.lcaOut, p.ucaOut), p.wheelCenter);
  const w = active ? 3.5 : 2.5;
  return (
    <group
      onDoubleClick={(e) => { e.stopPropagation(); onOpen(); }}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    >
      <Tri a={p.ucaFwd} b={p.ucaAft} c={p.ucaOut} color={COLORS.uca} opacity={0.22} />
      <Polyline pts={[p.ucaFwd, p.ucaOut, p.ucaAft]} color={COLORS.uca} width={w} />
      <Tri a={p.lcaFwd} b={p.lcaAft} c={p.lcaOut} color={COLORS.lca} opacity={0.22} />
      <Polyline pts={[p.lcaFwd, p.lcaOut, p.lcaAft]} color={COLORS.lca} width={w} />
      <Polyline pts={[p.ucaOut, p.lcaOut, p.trOuter, p.ucaOut]} color={COLORS.upright} width={w} />
      <Seg a={foot} b={p.wheelCenter} color={COLORS.upright} width={w} />
      <Seg a={p.trInner} b={p.trOuter} color={COLORS.tieRod} width={w} />
      {p.damperChassis && p.damperArm && <Coilover a={p.damperChassis} b={p.damperArm} color={COLORS.spring} radius={22} coils={7} />}
      {[p.ucaOut, p.lcaOut].map((q, i) => <Joint key={i} p={q} color={i ? COLORS.lca : COLORS.uca} r={8} />)}
      <Wheel
        center={p.wheelCenter} axis={axis} radius={view.profile.radius} width={view.profile.width}
        rimRadius={view.profile.rimRadius} color={active ? '#ffffff' : COLORS.wheel} simple={simpleTire}
        shoulder={simpleTire ? 0 : view.profile.shoulderRadius}
      />
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

function ForceArrows({ model }: { model: VehicleModel }) {
  const r = model.result;
  if (!r) return null;
  return (
    <>
      {CORNER_IDS.map((id) => {
        const c = r.corners[id];
        const base = model.corners[id]?.patch?.centroid ?? c.contact;
        const top = add(base, vec3(0, c.tireLoad * LOAD_SCALE, 0));
        const lat = add(base, vec3(c.lateralForce * LOAD_SCALE, 0, 0));
        return (
          <group key={id}>
            <Seg a={base} b={top} color="#ffd166" width={4} />
            {Math.abs(c.lateralForce) > 1 && <Seg a={base} b={lat} color="#ef476f" width={4} />}
          </group>
        );
      })}
    </>
  );
}

function VehicleScene({ model }: { model: VehicleModel }) {
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
  return (
    <group>
      <ambientLight intensity={0.8} />
      <directionalLight position={[1500, 2500, 2000]} intensity={1.2} />
      {vis.ground && (
        <Grid
          position={[0, model.groundY, -model.wheelbase / 2]} args={[8000, 8000]} cellSize={50} sectionSize={250}
          cellColor={COLORS.ground} sectionColor="#566075" fadeDistance={12000} infiniteGrid
        />
      )}
      {/* Chassis (everything sprung) moves with the solved pose. */}
      <group position={[0, pose.heave, 0]} rotation={euler}>
        <Frame model={model} />
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
      <ForceArrows model={model} />
      {model.sprungCgWorld && <Joint p={model.sprungCgWorld} color="#ffffff" r={16} />}
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

interface OverlayLabel { key: string; text: string; pos: Vec3; className?: string }

/** Screen-space labels for the vehicle view (positions follow the 3D points every frame). */
function overlayLabels(model: VehicleModel | null): OverlayLabel[] {
  const r = model?.result;
  if (!model || !r) return [];
  const out: OverlayLabel[] = CORNER_IDS.map((id) => {
    const c = r.corners[id];
    const base = model.corners[id]?.patch?.centroid ?? c.contact;
    return { key: id, text: `${id} ${c.tireLoad.toFixed(0)} N`, pos: add(base, vec3(0, c.tireLoad * LOAD_SCALE, 0)) };
  });
  if (model.sprungCgWorld) out.push({ key: 'cg', text: 'CG (sprung)', pos: model.sprungCgWorld, className: 'cg' });
  return out;
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
  const labels = useMemo(() => overlayLabels(model), [model]);
  const layer = useRef<HTMLDivElement>(null);
  return (
    <div className="viewport">
      <Canvas key={projection} dpr={[1, 2]} style={{ position: 'absolute', inset: 0 }}>
        <color attach="background" args={[bg]} />
        {projection === 'orthographic'
          ? <OrthographicCamera makeDefault position={[0, 300, 8000]} zoom={0.3} near={1} far={200000} />
          : <PerspectiveCamera makeDefault position={[0, 300, 6000]} fov={30} near={1} far={200000} />}
        <CameraRig target={target} />
        <DevProjectBridge />
        {model && <VehicleScene model={model} />}
        <LabelSync labels={labels} layer={layer} />
      </Canvas>
      <div className="label-layer" ref={layer}>
        {labels.map((l) => <div key={l.key} className={`load-label floating ${l.className ?? ''}`}>{l.text}</div>)}
      </div>
      <ViewButtons measure={false} />
      <div className="viewport-hint">Double-click a corner to edit it · arrows: tire load (yellow), lateral force (red)</div>
      {model?.error && <div className="viewport-error">{model.error}</div>}
    </div>
  );
}

