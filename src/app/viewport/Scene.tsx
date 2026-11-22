import { useState } from 'react';
import { Grid } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type * as THREE from 'three';
import { vec3, sub, add, scale, normalize, length, type Vec3 } from '../../core/math/vec3';
import { closestPointOnLine, lineThrough } from '../../core/math/geom';
import type { CornerPoints, CornerState } from '../../core/suspension/doubleWishbone';
import type { Characteristics } from '../../core/suspension/characteristics';
import type { LoadedCorner } from '../../core/suspension/loaded';
import { anyAxisLocked } from '../locks';
import { layoutOf, useApp, mountedTireWidth, POINT_NAMES, forCorner, selectedPoints, rootOf, type AnchorId, type ComponentId, type PointKey } from '../store';
import type { Model, Sample, Current } from '../useModel';
import { STATE_KEY, anchorPosition } from '../anchors';
import { Joint, Seg, Polyline, Tri, Wheel, Label, PatchMesh, Coilover, HitLink } from './primitives';
import { MoveGizmo } from './JointGizmo';
import { componentDefs } from '../components';
import { linkageShape } from './linkageShape';
import { MeasureOverlay } from './MeasureOverlay';
import { DimensionsOverlay } from './DimensionsOverlay';

export const COLORS = {
  chassis: '#8b93a1',
  /** Locked joints (fixed for the optimizer). */
  locked: '#ffd60a',
  uca: '#5b9cf5',
  lca: '#36c2b4',
  upright: '#f0a03c',
  tieRod: '#d36ef0',
  wheel: '#c9ced6',
  steering: '#f5d547',
  ic: '#ff6b6b',
  rc: '#7ee081',
  ground: '#3a4150',
  patch: '#ffb347',
  spring: '#ff7eb6',
  select: '#ffffff',
};

const TRAIL_KEYS: { key: keyof CornerPoints; color: string }[] = [
  { key: 'ucaOut', color: COLORS.uca },
  { key: 'lcaOut', color: COLORS.lca },
  { key: 'trOuter', color: COLORS.tieRod },
  { key: 'wheelCenter', color: COLORS.upright },
  { key: 'contact', color: COLORS.wheel },
];

/** Ignore clicks that were really camera drags. */
const isDrag = (e: ThreeEvent<MouseEvent>) => e.delta > 4;

/** True when a pickable joint is anywhere under the pointer (joints win over parts, e.g. inside the tire). */
const jointUnderPointer = (e: ThreeEvent<MouseEvent | PointerEvent>) =>
  e.intersections.some((i) => {
    for (let o: THREE.Object3D | null = i.object; o; o = o.parent) if (o.userData.joint) return true;
    return false;
  });

/** Upright spindle: from the wheel center to its foot on the steering axis. */
function spindleFoot(p: CornerPoints): Vec3 {
  return closestPointOnLine(lineThrough(p.steerLower, p.steerUpper), p.wheelCenter);
}

/** Pointer handlers that select a component (or are inert while measuring / for ghosts). */
function usePickComponent(id: ComponentId) {
  const select = useApp((s) => s.select);
  const measureMode = useApp((s) => s.measureMode);
  const [hover, setHover] = useState(false);
  return {
    hover,
    handlers: measureMode ? {} : {
      onClick: (e: ThreeEvent<MouseEvent>) => {
        if (isDrag(e) || jointUnderPointer(e)) return; // let the joint handle it
        e.stopPropagation();
        // Shift / Ctrl / Cmd adds the part's points to a multi-selection.
        const n = e.nativeEvent;
        if (n.shiftKey || n.ctrlKey || n.metaKey) { const g = useApp.getState().geom; useApp.getState().toggleSelectPoints(componentDefs(g.damperArm, g.kind, layoutOf(g), g.pushrodOn ?? 'lca', g.steerMechanism)[id].points); }
        else select({ kind: 'component', id });
      },
      onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; },
      onPointerOut: () => { setHover(false); document.body.style.cursor = ''; },
    },
  };
}

function Part({ id, children }: { id: ComponentId; children: (emphasis: number) => React.ReactNode }) {
  const selection = useApp((s) => s.selection);
  const { hover, handlers } = usePickComponent(id);
  const selected = selection?.kind === 'component' && selection.id === id;
  return <group {...handlers}>{children(selected ? 2 : hover ? 1 : 0)}</group>;
}

/** Width/colour emphasis for hover (1) and selection (2). */
const em = (base: number, e: number) => base + e * 1.5;

function Linkage({ state, faint = false }: { state: CornerState; faint?: boolean }) {
  const vis = useApp((s) => s.visibility);
  const p = state.points;
  const sh = linkageShape(p, state.kind);
  if (faint) {
    const o = 0.3;
    return (
      <group>
        {vis.uca && sh.uca.map(([a, b], i) => <Seg key={i} a={a} b={b} color={COLORS.uca} width={1} opacity={o} />)}
        {vis.lca && sh.lca.map(([a, b], i) => <Seg key={i} a={a} b={b} color={COLORS.lca} width={1} opacity={o} />)}
        {vis.upright && <Polyline pts={sh.upright} color={COLORS.upright} width={1} opacity={o} />}
        {vis.tieRod && <Seg a={p.trInner} b={p.trOuter} color={COLORS.tieRod} width={1} opacity={o} />}
        {vis.spring && p.damperChassis && p.damperArm && <Seg a={p.damperChassis} b={p.damperArm} color={COLORS.spring} width={1} opacity={o} />}
      </group>
    );
  }
  return (
    <group>
      {vis.uca && sh.uca.length > 0 && (
        <Part id="uca">{(e) => (
          <>
            {sh.ucaTri && <Tri a={sh.ucaTri[0]} b={sh.ucaTri[1]} c={sh.ucaTri[2]} color={e ? '#8fbaff' : COLORS.uca} opacity={0.25 + e * 0.1} />}
            {sh.uca.map(([a, b], i) => (
              <group key={i}>
                <Seg a={a} b={b} color={e === 2 ? COLORS.select : COLORS.uca} width={em(3, e)} />
                {!sh.ucaTri && <HitLink a={a} b={b} radius={12} />}
              </group>
            ))}
          </>
        )}</Part>
      )}
      {vis.lca && (
        <Part id="lca">{(e) => (
          <>
            {sh.lcaTri && <Tri a={sh.lcaTri[0]} b={sh.lcaTri[1]} c={sh.lcaTri[2]} color={e ? '#7fe3d8' : COLORS.lca} opacity={0.25 + e * 0.1} />}
            {sh.lca.map(([a, b], i) => (
              <group key={i}>
                <Seg a={a} b={b} color={e === 2 ? COLORS.select : COLORS.lca} width={em(3, e)} />
                {!sh.lcaTri && <HitLink a={a} b={b} radius={12} />}
              </group>
            ))}
          </>
        )}</Part>
      )}
      {vis.upright && (
        <Part id="upright">{(e) => (
          <>
            <Tri a={sh.upright[0]!} b={sh.upright[1]!} c={sh.upright[2]!} color={COLORS.upright} opacity={0.35 + e * 0.1} />
            <Polyline pts={sh.upright} color={e === 2 ? COLORS.select : COLORS.upright} width={em(3, e)} />
            <Seg a={spindleFoot(p)} b={p.wheelCenter} color={e === 2 ? COLORS.select : COLORS.upright} width={em(3, e)} />
            <HitLink a={spindleFoot(p)} b={p.wheelCenter} radius={12} />
          </>
        )}</Part>
      )}
      {vis.tieRod && (
        <Part id="tieRod">{(e) => (
          <>
            <Seg a={p.trInner} b={p.trOuter} color={e === 2 ? COLORS.select : COLORS.tieRod} width={em(3, e)} />
            <HitLink a={p.trInner} b={p.trOuter} radius={12} />
          </>
        )}</Part>
      )}
      {vis.spring && p.damperChassis && p.damperArm && (
        <Part id="spring">{(e) => (
          <>
            <Coilover a={p.damperChassis!} b={p.damperArm!} color={e === 2 ? COLORS.select : COLORS.spring} />
            <HitLink a={p.damperChassis!} b={p.damperArm!} radius={30} />
            {p.rockerPivot1 && p.rockerPivot2 && p.pushrodUpper && p.pushrodLower && (() => {
              const c = scale(add(p.rockerPivot1!, p.rockerPivot2!), 0.5);
              return (
                <>
                  <Tri a={c} b={p.pushrodUpper!} c={p.damperArm!} color={COLORS.spring} opacity={0.3 + e * 0.1} />
                  <Polyline pts={[c, p.pushrodUpper!, p.damperArm!, c]} color={e === 2 ? COLORS.select : COLORS.spring} width={em(3, e)} />
                  <Seg a={p.rockerPivot1!} b={p.rockerPivot2!} color={COLORS.chassis} width={em(3, e)} />
                  <Seg a={p.pushrodLower!} b={p.pushrodUpper!} color={e === 2 ? COLORS.select : COLORS.tieRod} width={em(3, e)} />
                  <HitLink a={p.pushrodLower!} b={p.pushrodUpper!} radius={14} />
                </>
              );
            })()}
          </>
        )}</Part>
      )}
    </group>
  );
}

/** A clickable hardpoint: selects the point (opening the joint menu) or adds it to a measurement. */
function PickJoint({ id, p, color, r = 7 }: { id: AnchorId; p: Vec3; color: string; r?: number }) {
  const measureMode = useApp((s) => s.measureMode);
  const select = useApp((s) => s.select);
  const addMeasureAnchor = useApp((s) => s.addMeasureAnchor);
  const selection = useApp((s) => s.selection);
  const measure = useApp((s) => s.measure);
  const [hover, setHover] = useState(false);
  const isPoint = id in STATE_KEY;
  const locked = useApp((s) => isPoint && anyAxisLocked(s.locks, rootOf(s.activeCorner, s.links), id as PointKey, s.geom.damperArm, s.geom.kind, layoutOf(s.geom), s.geom.steerMechanism));
  const selected = (selection?.kind === 'point' && selection.id === id)
    || (selection?.kind === 'points' && selection.ids.includes(id as PointKey))
    || measure.includes(id);
  return (
    <group
      userData={{ joint: true }}
      onClick={(e) => {
        if (isDrag(e)) return;
        e.stopPropagation();
        const n = e.nativeEvent;
        if (measureMode) addMeasureAnchor(id, p);
        else if (isPoint && (n.shiftKey || n.ctrlKey || n.metaKey)) useApp.getState().toggleSelectPoints([id as PointKey]);
        else if (isPoint) select({ kind: 'point', id: id as PointKey });
      }}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}
    >
      <Joint p={p} color={selected ? COLORS.select : locked ? COLORS.locked : color} r={r * (hover || selected ? 1.6 : 1)} />
    </group>
  );
}

function Joints({ state, cur }: { state: CornerState; cur: Current }) {
  const vis = useApp((s) => s.visibility);
  const measureMode = useApp((s) => s.measureMode);
  const p = state.points;
  return (
    <group>
      {vis.chassis && (state.kind === 'rigid' ? ([] as const) : state.kind === 'macpherson' || state.kind === 'singleArm' ? (['lcaFwd', 'lcaAft'] as const) : (['ucaFwd', 'ucaAft', 'lcaFwd', 'lcaAft'] as const)).map((k) => <PickJoint key={k} id={k} p={p[k]} color={COLORS.chassis} />)}
      {(vis.uca || vis.upright) && state.kind !== 'macpherson' && <PickJoint id="ucaOut" p={p.ucaOut} color={COLORS.uca} r={9} />}
      {(vis.lca || vis.upright) && <PickJoint id="lcaOut" p={p.lcaOut} color={COLORS.lca} r={9} />}
      {state.kind === 'multilink' && (vis.uca || vis.upright) && p.ucaOut2 && <PickJoint id="ucaOut2" p={p.ucaOut2} color={COLORS.uca} r={9} />}
      {state.kind === 'multilink' && (vis.lca || vis.upright) && p.lcaOut2 && <PickJoint id="lcaOut2" p={p.lcaOut2} color={COLORS.lca} r={9} />}
      {vis.tieRod && <PickJoint id="trInner" p={p.trInner} color={COLORS.chassis} />}
      {vis.chassis && p.steerPivot1 && <PickJoint id="strPiv1" p={p.steerPivot1} color={COLORS.chassis} />}
      {vis.chassis && p.steerPivot2 && <PickJoint id="strPiv2" p={p.steerPivot2} color={COLORS.chassis} />}
      {vis.spring && p.damperChassis && <PickJoint id="dmpChassis" p={p.damperChassis} color={COLORS.chassis} />}
      {vis.spring && p.damperArm && <PickJoint id="dmpArm" p={p.damperArm} color={COLORS.spring} />}
      {vis.spring && p.rockerPivot1 && <PickJoint id="rkrPiv1" p={p.rockerPivot1} color={COLORS.chassis} />}
      {vis.spring && p.rockerPivot2 && <PickJoint id="rkrPiv2" p={p.rockerPivot2} color={COLORS.chassis} />}
      {vis.spring && p.pushrodLower && <PickJoint id="prArm" p={p.pushrodLower} color={COLORS.tieRod} />}
      {vis.spring && p.pushrodUpper && <PickJoint id="prRkr" p={p.pushrodUpper} color={COLORS.spring} />}
      {(vis.tieRod || vis.upright) && <PickJoint id="trOuter" p={p.trOuter} color={COLORS.tieRod} />}
      {vis.wheel && <PickJoint id="wheelCenter" p={p.wheelCenter} color={COLORS.upright} r={6} />}
      {vis.wheel && <PickJoint id="contact" p={p.contact} color={COLORS.wheel} r={6} />}
      {/* Derived points are pickable for measuring. */}
      {measureMode && (['patchCentroid', 'axisGround', 'rollCenter', 'frontViewIC'] as const).map((id) => {
        const q = anchorPosition(id, cur);
        return q && length(sub(q, p.contact)) < 20000 ? <PickJoint key={id} id={id} p={q} color={COLORS.steering} r={6} /> : null;
      })}
    </group>
  );
}

function Chassis({ state, rackLimit, rackAxis }: { state: CornerState; rackLimit: number; rackAxis: Vec3 }) {
  const p = state.points;
  const rackCenter = sub(p.trInner, scale(rackAxis, state.inputs.rack));
  const ext = (a: Vec3, b: Vec3, e = 60) => {
    const d = normalize(sub(b, a));
    return [sub(a, scale(d, -e)), add(b, scale(d, -e))] as const;
  };
  // Chassis rails along the arms' pivot lines (a MacPherson has no upper arm: its rail is at the top mount).
  const rail = (q: Vec3) => ext(add(q, vec3(-120, 0, 120)), add(q, vec3(-120, 0, -120)));
  const [u1, u2] = state.kind === 'rigid' ? rail(p.ucaOut) : state.kind === 'singleArm' ? ext(p.lcaFwd, p.lcaAft) : state.kind === 'macpherson' && p.strutTop ? ext(add(p.strutTop, vec3(0, 0, 120)), sub(p.strutTop, vec3(0, 0, 120))) : ext(p.ucaFwd, p.ucaAft);
  const [l1, l2] = state.kind === 'rigid' ? rail(p.lcaOut) : ext(p.lcaFwd, p.lcaAft);
  const r1 = add(rackCenter, scale(rackAxis, -rackLimit));
  const r2 = add(rackCenter, scale(rackAxis, rackLimit));
  return (
    <group>
      <Part id="chassis">{(e) => (
        <>
          <Seg a={u1} b={u2} color={e === 2 ? COLORS.select : COLORS.chassis} width={em(4, e)} />
          <Seg a={l1} b={l2} color={e === 2 ? COLORS.select : COLORS.chassis} width={em(4, e)} />
          <HitLink a={u1} b={u2} radius={14} />
          <HitLink a={l1} b={l2} radius={14} />
          <Polyline
            pts={[vec3(0, 0, -400), vec3(0, 0, 400), vec3(0, 450, 400), vec3(0, 450, -400), vec3(0, 0, -400)]}
            color={COLORS.chassis} width={1} opacity={0.35}
          />
        </>
      )}</Part>
      <Part id="rack">{(e) => p.steerPivot1 && p.steerPivot2 ? (
        <>
          {/* Steering arm / plate: its pivot axis and the arm out to the inner tie-rod joint. */}
          <Seg a={p.steerPivot1} b={p.steerPivot2} color={e === 2 ? COLORS.select : COLORS.chassis} width={em(3, e)} />
          <Seg a={closestPointOnLine(lineThrough(p.steerPivot1, p.steerPivot2), p.trInner)} b={p.trInner} color={e === 2 ? COLORS.select : COLORS.tieRod} width={em(3, e)} />
          <HitLink a={p.steerPivot1} b={p.steerPivot2} radius={14} />
        </>
      ) : (
        <>
          <Seg a={r1} b={r2} color={e === 2 ? COLORS.select : COLORS.chassis} width={em(2, e)} dashed={e === 0} />
          <HitLink a={r1} b={r2} radius={14} />
        </>
      )}</Part>
    </group>
  );
}

function Construction({ state, chars, loaded }: { state: CornerState; chars: Characteristics; loaded: LoadedCorner | null }) {
  const vis = useApp((s) => s.visibility);
  const p = state.points;
  const cp = chars.contactPoint;
  const ic = chars.frontViewIC;
  const icNear = ic && length(sub(ic, cp)) < 20000 ? ic : null;
  const rc = chars.rollCenterHeight !== null ? vec3(0, chars.groundY + chars.rollCenterHeight, cp.z) : null;
  const axisTop = add(p.steerUpper, scale(sub(p.steerUpper, p.steerLower), 0.35));
  const axisGround = loaded ? loaded.steeringAxisAtGround : chars.steeringAxisAtGround;
  return (
    <group>
      {vis.steeringAxis && axisGround && (
        <>
          <Seg a={axisGround} b={axisTop} color={COLORS.steering} width={1.5} dashed />
          <Joint p={axisGround} color={COLORS.steering} r={5} />
        </>
      )}
      {vis.icConstruction && icNear && (
        <>
          <Seg a={p.steerUpper} b={icNear} color={COLORS.ic} width={1} dashed opacity={0.8} />
          <Seg a={p.steerLower} b={icNear} color={COLORS.ic} width={1} dashed opacity={0.8} />
          <Joint p={icNear} color={COLORS.ic} r={10} />
        </>
      )}
      {vis.rollCenter && rc && (
        <>
          <Seg a={cp} b={rc} color={COLORS.rc} width={1.5} dashed />
          <Seg a={vec3(-cp.x, cp.y, cp.z)} b={rc} color={COLORS.rc} width={1} dashed opacity={0.4} />
          <Joint p={rc} color={COLORS.rc} r={10} />
        </>
      )}
    </group>
  );
}

function Trails({ sweep }: { sweep: Sample[] }) {
  return (
    <group>
      {TRAIL_KEYS.map(({ key, color }) => (
        <Polyline key={key} pts={sweep.map((s) => s.state.points[key] as Vec3)} color={color} width={2} opacity={0.9} />
      ))}
    </group>
  );
}

function Ghosts({ sweep, radius }: { sweep: Sample[]; radius: number }) {
  const vis = useApp((s) => s.visibility);
  if (sweep.length < 2) return null;
  const ends = [sweep[0]!, sweep[sweep.length - 1]!];
  return (
    <group>
      {ends.map((s, i) => (
        <group key={i}>
          <Linkage state={s.state} faint />
          {vis.wheel && <Wheel center={s.state.points.wheelCenter} axis={s.state.spinAxis} radius={radius} width={0} color={COLORS.wheel} ghost />}
        </group>
      ))}
    </group>
  );
}

function Labels({ state }: { state: CornerState }) {
  const active = useApp((s) => s.activeCorner);
  const p = state.points;
  const entries: [Vec3, string][] = (Object.keys(STATE_KEY) as PointKey[])
    .map((k) => [p[STATE_KEY[k]] as Vec3 | undefined, forCorner(active, POINT_NAMES[k])] as const)
    .filter((e): e is [Vec3, string] => Boolean(e[0]));
  entries.push([p.contact, 'Contact']);
  return <>{entries.map(([q, t]) => <Label key={t} p={q} text={t} />)}</>;
}

export function Scene({ model }: { model: Model }) {
  const vis = useApp((s) => s.visibility);
  const trails = useApp((s) => s.trails);
  const ghosts = useApp((s) => s.ghosts);
  const rackLimit = useApp((s) => s.steer.rackLimit.value);
  const width = useApp((s) => mountedTireWidth(s.geom.scalars));
  const radius = useApp((s) => s.geom.scalars.tireDiameter.value / 2);
  const shoulder = useApp((s) => s.geom.scalars.shoulderRadius.value);
  const simpleTire = useApp((s) => s.simpleTire);
  const damperArm = useApp((s) => s.geom.damperArm);
  const kind = useApp((s) => s.geom.kind);
  const layout = useApp((s) => layoutOf(s.geom));
  const pushrodOn = useApp((s) => s.geom.pushrodOn ?? 'lca');
  const steerMech = useApp((s) => s.geom.steerMechanism ?? 'rack');
  const rimRadius = useApp((s) => s.geom.scalars.rimDiameter.value / 2);
  const selection = useApp((s) => s.selection);
  const measureMode = useApp((s) => s.measureMode);
  const cur = model.current;
  if (!cur || !model.corner) return null;
  const { state, chars, loaded } = cur;
  const groundY = loaded ? loaded.groundY : chars.groundY;
  const cx = chars.contactPoint.x;
  const cz = chars.contactPoint.z;
  return (
    <group>
      <ambientLight intensity={0.8} />
      <directionalLight position={[1500, 2500, 2000]} intensity={1.2} />
      {vis.datum && <axesHelper args={[150]} />}
      {vis.ground && (
        <>
          {/* Ground reference lines (the grid is invisible edge-on in front/side views) */}
          <Seg a={vec3(-cx - 300, groundY, cz)} b={vec3(cx + 400, groundY, cz)} color="#566075" width={1.5} />
          <Seg a={vec3(cx, groundY, cz - 600)} b={vec3(cx, groundY, cz + 600)} color="#566075" width={1.5} />
          <Grid
            position={[0, groundY, 0]} args={[6000, 6000]} cellSize={50} sectionSize={250}
            cellColor={COLORS.ground} sectionColor="#566075" fadeDistance={9000} infiniteGrid
          />
        </>
      )}
      {vis.patch && loaded?.patch.inContact && (
        <>
          <PatchMesh outline={loaded.patch.outline} centroid={loaded.patch.centroid!} color={loaded.bottomedOut ? '#f06363' : COLORS.patch} />
          <Joint p={loaded.patch.centroid!} color={COLORS.patch} r={6} />
        </>
      )}
      {vis.chassis && <Chassis state={state} rackLimit={rackLimit} rackAxis={model.corner.rackAxis} />}
      <Linkage state={state} />
      {vis.wheel && (
        <Part id="wheel">{(e) => (
          <Wheel center={state.points.wheelCenter} axis={state.spinAxis} radius={radius} width={width} shoulder={simpleTire ? 0 : shoulder} rimRadius={rimRadius} simple={simpleTire} color={e === 2 ? COLORS.select : COLORS.wheel} />
        )}</Part>
      )}
      <Joints state={state} cur={cur} />
      <Construction state={state} chars={chars} loaded={loaded} />
      {trails && <Trails sweep={model.sweep} />}
      {ghosts && <Ghosts sweep={model.sweep} radius={radius} />}
      {vis.labels && <Labels state={state} />}
      {!measureMode && selection && (
        <MoveGizmo ids={selectedPoints(selection, (c) => componentDefs(damperArm, kind, layout, pushrodOn, steerMech)[c].points)} cur={cur} />
      )}
      {measureMode && <MeasureOverlay cur={cur} />}
      {vis.dimensions && <DimensionsOverlay cur={cur} />}
    </group>
  );
}
