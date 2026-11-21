import { Grid } from '@react-three/drei';
import { vec3, sub, add, scale, normalize, length, type Vec3 } from '../../core/math/vec3';
import { closestPointOnLine, lineThrough } from '../../core/math/geom';
import type { CornerPoints, CornerState } from '../../core/suspension/doubleWishbone';
import type { Characteristics } from '../../core/suspension/characteristics';
import type { LoadedCorner } from '../../core/suspension/loaded';
import { useApp, POINT_NAMES } from '../store';
import type { Model, Sample } from '../useModel';
import { Joint, Seg, Polyline, Tri, Wheel, Label, PatchMesh, Coilover } from './primitives';

export const COLORS = {
  chassis: '#8b93a1',
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
};

const TRAIL_KEYS: { key: keyof CornerPoints; color: string }[] = [
  { key: 'ucaOut', color: COLORS.uca },
  { key: 'lcaOut', color: COLORS.lca },
  { key: 'trOuter', color: COLORS.tieRod },
  { key: 'wheelCenter', color: COLORS.upright },
  { key: 'contact', color: COLORS.wheel },
];

/** Upright spindle: from the wheel center to its foot on the ball-joint axis. */
function spindleFoot(p: CornerPoints): Vec3 {
  return closestPointOnLine(lineThrough(p.lcaOut, p.ucaOut), p.wheelCenter);
}

function Linkage({ state, faint = false }: { state: CornerState; faint?: boolean }) {
  const vis = useApp((s) => s.visibility);
  const p = state.points;
  const o = faint ? 0.3 : 1;
  const w = faint ? 1 : 3;
  return (
    <group>
      {vis.uca && (
        <>
          {!faint && <Tri a={p.ucaFwd} b={p.ucaAft} c={p.ucaOut} color={COLORS.uca} opacity={0.25} />}
          <Seg a={p.ucaFwd} b={p.ucaOut} color={COLORS.uca} width={w} opacity={o} />
          <Seg a={p.ucaAft} b={p.ucaOut} color={COLORS.uca} width={w} opacity={o} />
        </>
      )}
      {vis.lca && (
        <>
          {!faint && <Tri a={p.lcaFwd} b={p.lcaAft} c={p.lcaOut} color={COLORS.lca} opacity={0.25} />}
          <Seg a={p.lcaFwd} b={p.lcaOut} color={COLORS.lca} width={w} opacity={o} />
          <Seg a={p.lcaAft} b={p.lcaOut} color={COLORS.lca} width={w} opacity={o} />
        </>
      )}
      {vis.upright && (
        <>
          {!faint && <Tri a={p.ucaOut} b={p.lcaOut} c={p.trOuter} color={COLORS.upright} opacity={0.35} />}
          <Polyline pts={[p.ucaOut, p.lcaOut, p.trOuter, p.ucaOut]} color={COLORS.upright} width={w} opacity={o} />
          <Seg a={spindleFoot(p)} b={p.wheelCenter} color={COLORS.upright} width={w} opacity={o} />
        </>
      )}
      {vis.tieRod && <Seg a={p.trInner} b={p.trOuter} color={COLORS.tieRod} width={w} opacity={o} />}
      {vis.spring && p.damperChassis && p.damperArm && (
        faint
          ? <Seg a={p.damperChassis} b={p.damperArm} color={COLORS.spring} width={1} opacity={o} />
          : <Coilover a={p.damperChassis} b={p.damperArm} color={COLORS.spring} />
      )}
    </group>
  );
}

function Joints({ state }: { state: CornerState }) {
  const vis = useApp((s) => s.visibility);
  const p = state.points;
  return (
    <group>
      {vis.chassis && [p.ucaFwd, p.ucaAft, p.lcaFwd, p.lcaAft].map((q, i) => <Joint key={i} p={q} color={COLORS.chassis} />)}
      {(vis.uca || vis.upright) && <Joint p={p.ucaOut} color={COLORS.uca} r={9} />}
      {(vis.lca || vis.upright) && <Joint p={p.lcaOut} color={COLORS.lca} r={9} />}
      {vis.tieRod && <Joint p={p.trInner} color={COLORS.chassis} />}
      {vis.spring && p.damperChassis && <Joint p={p.damperChassis} color={COLORS.chassis} />}
      {vis.spring && p.damperArm && <Joint p={p.damperArm} color={COLORS.spring} />}
      {(vis.tieRod || vis.upright) && <Joint p={p.trOuter} color={COLORS.tieRod} />}
      {vis.wheel && <Joint p={p.wheelCenter} color={COLORS.upright} r={6} />}
      {vis.wheel && <Joint p={p.contact} color={COLORS.wheel} r={6} />}
    </group>
  );
}

function Chassis({ state, rackRange, rackAxis }: { state: CornerState; rackRange: number; rackAxis: Vec3 }) {
  const p = state.points;
  const rackCenter = sub(p.trInner, scale(rackAxis, state.inputs.rack));
  const ext = (a: Vec3, b: Vec3, e = 60) => {
    const d = normalize(sub(b, a));
    return [sub(a, scale(d, -e)), add(b, scale(d, -e))] as const;
  };
  const [u1, u2] = ext(p.ucaFwd, p.ucaAft);
  const [l1, l2] = ext(p.lcaFwd, p.lcaAft);
  return (
    <group>
      <Seg a={u1} b={u2} color={COLORS.chassis} width={4} />
      <Seg a={l1} b={l2} color={COLORS.chassis} width={4} />
      <Seg a={add(rackCenter, scale(rackAxis, -rackRange))} b={add(rackCenter, scale(rackAxis, rackRange))} color={COLORS.chassis} width={2} dashed />
      {/* Vehicle center plane outline (X = 0) */}
      <Polyline
        pts={[vec3(0, 0, -400), vec3(0, 0, 400), vec3(0, 450, 400), vec3(0, 450, -400), vec3(0, 0, -400)]}
        color={COLORS.chassis} width={1} opacity={0.35}
      />
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
  const axisTop = add(p.ucaOut, scale(sub(p.ucaOut, p.lcaOut), 0.35));
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
          <Seg a={p.ucaOut} b={icNear} color={COLORS.ic} width={1} dashed opacity={0.8} />
          <Seg a={p.lcaOut} b={icNear} color={COLORS.ic} width={1} dashed opacity={0.8} />
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
  const p = state.points;
  const entries: [Vec3, string][] = [
    [p.ucaFwd, POINT_NAMES.ucaFwd], [p.ucaAft, POINT_NAMES.ucaAft], [p.ucaOut, POINT_NAMES.ucaOut],
    [p.lcaFwd, POINT_NAMES.lcaFwd], [p.lcaAft, POINT_NAMES.lcaAft], [p.lcaOut, POINT_NAMES.lcaOut],
    [p.trInner, POINT_NAMES.trInner], [p.trOuter, POINT_NAMES.trOuter], [p.wheelCenter, POINT_NAMES.wheelCenter],
    [p.contact, 'Contact'],
    ...(p.damperChassis && p.damperArm ? [[p.damperChassis, POINT_NAMES.dmpChassis], [p.damperArm, POINT_NAMES.dmpArm]] as [Vec3, string][] : []),
  ];
  return <>{entries.map(([q, t]) => <Label key={t} p={q} text={t} />)}</>;
}

export function Scene({ model }: { model: Model }) {
  const vis = useApp((s) => s.visibility);
  const trails = useApp((s) => s.trails);
  const ghosts = useApp((s) => s.ghosts);
  const rackRange = useApp((s) => s.rackRange);
  const width = useApp((s) => s.geom.scalars.tireWidth.value);
  const radius = useApp((s) => s.geom.scalars.tireDiameter.value / 2);
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
        </>
      )}
      {vis.patch && loaded?.patch.inContact && (
        <>
          <PatchMesh outline={loaded.patch.outline} centroid={loaded.patch.centroid!} color={loaded.bottomedOut ? '#f06363' : COLORS.patch} />
          <Joint p={loaded.patch.centroid!} color={COLORS.patch} r={6} />
        </>
      )}
      {vis.ground && (
        <Grid
          position={[0, groundY, 0]} args={[6000, 6000]} cellSize={50} sectionSize={250}
          cellColor={COLORS.ground} sectionColor="#566075" fadeDistance={9000} infiniteGrid
        />
      )}
      {vis.chassis && <Chassis state={state} rackRange={rackRange} rackAxis={model.corner.rackAxis} />}
      <Linkage state={state} />
      <Joints state={state} />
      {vis.wheel && <Wheel center={state.points.wheelCenter} axis={state.spinAxis} radius={radius} width={width} color={COLORS.wheel} />}
      <Construction state={state} chars={chars} loaded={loaded} />
      {trails && <Trails sweep={model.sweep} />}
      {ghosts && <Ghosts sweep={model.sweep} radius={radius} />}
      {vis.labels && <Labels state={state} />}
    </group>
  );
}
