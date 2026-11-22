/**
 * Test playback (Phase A): the car driven through the test frame by frame (every 0.1 s), each frame a
 * steady state. Play / pause, scrub, speed; a top-view map of the track colored by Pass / Warning /
 * Fail. Each frame poses the 3D car (the Vehicle view's accelerations, grade, bank, wheel bumps and the
 * steering the turn needs). Space plays / pauses.
 * Also the track map shown while building a test (from the segments alone, no run needed).
 */
import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import type { PlaybackFrame } from '../../core/tests/run';
import { trackPath } from '../../core/tests/segments';
import type { Severity } from '../../core/tests/checks';
import { CORNER_IDS } from '../../core/vehicle/vehicle';
import { useApp } from '../store';
import { buildVehicleProblem, runPlaybackJob } from '../optimizer';
import { segmentSpec, type TestDesign } from '../tests';
import { useRun } from './TestsPanels';
import { useDisplay } from '../units';
import { fmt } from './FieldRows';

interface PlaybackState {
  testId: string | null;
  frames: PlaybackFrame[];
  computing: boolean;
  error: string | null;
  playing: boolean;
  t: number;
  rate: number;
  /** Design used (stale if it changed). */
  from: unknown;
}
export const usePlayback = create<PlaybackState>(() => ({ testId: null, frames: [], computing: false, error: null, playing: false, t: 0, rate: 1, from: null }));

const frameAt = (frames: PlaybackFrame[], t: number) => {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (frames[m]!.t <= t) lo = m; else hi = m - 1; }
  return frames[lo];
};

/** Pose the 3D car for a frame (sets the Vehicle view's sliders and road). */
function applyFrame(f: PlaybackFrame) {
  const s = useApp.getState();
  s.set('lateralG', Number(f.ay.toFixed(3)));
  s.set('longitudinalG', Number(f.ax.toFixed(3)));
  s.set('roadGrade', Number((Math.tan(f.grade) * 100).toFixed(2)));
  s.set('roadBank', Number(((f.bank * 180) / Math.PI).toFixed(2)));
  s.set('wheelBumps', { FL: 0, FR: 0, RL: 0, RR: 0, ...f.groundOffset });
  s.set('rack', Number((f.rack ?? 0).toFixed(2)));
  s.set('testView', null);
  s.set('rideView', f.ride ? { pose: f.ride.pose, travel: f.ride.travel } : null);
}

async function computeFrames(test: TestDesign) {
  const s = useApp.getState();
  usePlayback.setState({ computing: true, error: null, playing: false, testId: test.id, from: { geom: s.geom, corners: s.corners, test } });
  try {
    // The last run already drove the test over time: reuse it while the design is the same.
    const last = useRun.getState().results[test.id];
    const fresh = last && last.from.geom === s.geom && last.from.corners === s.corners && last.from.settings === s.settings && last.from.vehicle === s.vehicle;
    const handling = test.ride !== false && test.handling !== false;
    const reuse = test.ride !== false && fresh && (last.test === undefined || last.test === test) && last.result.ride?.frames.length && !!last.result.ride.frames[0]!.handling === handling ? last.result.ride.frames : null;
    const { problem } = buildVehicleProblem(s);
    const frames = reuse ?? await runPlaybackJob(problem, test.segments.map((sg) => segmentSpec(sg, test)), test.ride !== false, handling).done;
    usePlayback.setState({ frames, computing: false, t: 0 });
    if (frames[0]) applyFrame(frames[0]);
    return frames;
  } catch (e) {
    usePlayback.setState({ computing: false, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

const SEV_COLOR: Record<string, string> = { pass: '#5cdc6a', warn: '#ffb703', fail: '#ff5c5c' };

/** Top view of the track, colored by result, with the car. */
function TrackMap({ frames, current }: { frames: PlaybackFrame[]; current: PlaybackFrame | undefined }) {
  const box = useMemo(() => {
    const xs = frames.map((f) => f.pos.x), ys = frames.map((f) => f.pos.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY, 1);
    return { minX, minY, span, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }, [frames]);
  if (!frames.length) return null;
  const W = 150, H = 110, pad = 8;
  const k = Math.min((W - 2 * pad) / box.span, (H - 2 * pad) / box.span);
  const px = (x: number) => W / 2 + (x - box.cx) * k;
  const py = (y: number) => H / 2 - (y - box.cy) * k;
  return (
    <svg className="track-map" viewBox={`0 0 ${W} ${H}`} aria-label="Track map: the line driven, colored by result (grey: the path)">
      {frames[0]!.handling && (
        <polyline points={frames.map((f) => `${px(f.handling!.path.x).toFixed(1)},${py(f.handling!.path.y).toFixed(1)}`).join(' ')} fill="none" stroke="#8a93a3" strokeWidth={1} strokeDasharray="3 2" />
      )}
      {frames.slice(1).map((f, i) => (
        <line key={i} x1={px(frames[i]!.pos.x)} y1={py(frames[i]!.pos.y)} x2={px(f.pos.x)} y2={py(f.pos.y)} stroke={SEV_COLOR[f.severity]} strokeWidth={3} strokeLinecap="round" />
      ))}
      {current && (
        <g transform={`translate(${px(current.pos.x)},${py(current.pos.y)}) rotate(${(-current.heading * 180) / Math.PI})`}>
          <polygon points="7,0 -5,-4 -5,4" fill="#ffffff" stroke="#16191e" strokeWidth={1} />
        </g>
      )}
    </svg>
  );
}

export function PlaybackBar({ test }: { test: TestDesign | null }) {
  const pb = usePlayback();
  const geom = useApp((s) => s.geom);
  const corners = useApp((s) => s.corners);
  const disp = useDisplay();
  const raf = useRef(0);
  const frames = pb.testId === test?.id ? pb.frames : [];
  const total = frames.length ? frames[frames.length - 1]!.t : 0;
  const cur = frames.length ? frameAt(frames, pb.t) : undefined;
  const stale = useMemo(() => {
    const f = pb.from as { geom: unknown; corners: unknown; test?: unknown } | null;
    // The car or the test (segments, options) changed since the frames were computed.
    return !!f && pb.testId === test?.id && (f.geom !== geom || f.corners !== corners || (f.test !== undefined && f.test !== test));
  }, [pb.from, pb.testId, test, geom, corners]);

  // Animation: advance time; pose the car when the frame changes.
  useEffect(() => {
    if (!pb.playing || !frames.length) return;
    let last = performance.now();
    let lastFrame: PlaybackFrame | undefined;
    const tick = (now: number) => {
      const st = usePlayback.getState();
      let t = st.t + ((now - last) / 1000) * st.rate;
      last = now;
      if (t >= total) { t = total; usePlayback.setState({ playing: false }); }
      usePlayback.setState({ t });
      const f = frameAt(frames, t);
      if (f && f !== lastFrame) { lastFrame = f; applyFrame(f); }
      if (usePlayback.getState().playing) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [pb.playing, frames, total]);

  const play = async () => {
    if (!test || usePlayback.getState().computing) return;
    let fs = frames;
    if (!fs.length || stale) fs = await computeFrames(test);
    if (!fs.length) return;
    const st = usePlayback.getState();
    if (st.t >= (fs[fs.length - 1]?.t ?? 0)) usePlayback.setState({ t: 0 });
    usePlayback.setState({ playing: true });
  };
  // Space plays / pauses (not while typing in a field).
  const toggle = useRef<() => void>(() => {});
  toggle.current = () => {
    if (usePlayback.getState().playing) usePlayback.setState({ playing: false });
    else void play();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
        || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox'));
      if (typing || document.querySelector('.modal')) return;
      e.preventDefault();
      // A focused button would also click on Space: keep it to play / pause.
      if (t && t.tagName === 'BUTTON') t.blur();
      toggle.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const seek = (t: number) => {
    usePlayback.setState({ t, playing: false });
    const f = frameAt(frames, t);
    if (f) applyFrame(f);
  };

  return (
    <div className="motion-bar playback-bar">
      <TrackMap frames={frames} current={cur} />
      <div className="playback-main">
        <div className="jm-row">
          {!pb.playing
            ? <button onClick={() => void play()} disabled={!test || pb.computing} title={`${frames.length && !stale ? 'Play' : 'Drive the car through the test (computes every 0.1 s)'} (Space)`}>{pb.computing ? <><span className="spinner" /> Preparing…</> : '▶ Play'}</button>
            : <button onClick={() => usePlayback.setState({ playing: false })} title="Pause (Space)">❚❚ Pause</button>}
          <input type="range" min={0} max={total || 1} step={0.05} value={Math.min(pb.t, total)} disabled={!frames.length} onChange={(e) => seek(Number(e.target.value))} className="playback-slider" />
          <span className="mono small-text">{fmt(Math.min(pb.t, total), 1)} / {fmt(total, 1)} s</span>
          <select value={pb.rate} onChange={(e) => usePlayback.setState({ rate: Number(e.target.value) })} title="Playback speed">
            {[0.25, 0.5, 1, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </div>
        {cur && test ? (
          <div className="small-text playback-hud">
            <b>{cur.segment + 1}. {test.segments[cur.segment]?.name}</b> · {disp.format(cur.speed, 'm/s', 0)} · lateral {fmt(cur.ay, 2)} g · long. {fmt(cur.ax, 2)} g
            {cur.rack ? ` · rack ${fmt(cur.rack, 1)} mm` : ''}
            {cur.ride ? ` · roll ${fmt((cur.ride.pose.roll * 180) / Math.PI, 2)}° · pitch ${fmt((cur.ride.pose.pitch * 180) / Math.PI, 2)}°` : ''}
            {cur.handling && (
              <span title="Handling (driver steering): distance off the path (+ = left of it), sideslip angle (where the car points vs where it goes) and the road-wheel steer angle">
                {' · off line '}<span className={Math.abs(cur.handling.pathError) > 1 ? 'bad-text' : Math.abs(cur.handling.pathError) > 0.5 ? 'warn-text' : ''}>{fmt(cur.handling.pathError, 2)} m</span>
                {' · sideslip '}<span className={Math.abs(cur.handling.sideslip) > 12 ? 'bad-text' : Math.abs(cur.handling.sideslip) > 6 ? 'warn-text' : ''}>{fmt(cur.handling.sideslip, 1)}°</span>
                {` · steer ${fmt(cur.handling.steer, 1)}°`}{cur.handling.atLock ? <span className="warn-text"> (full lock)</span> : null}
              </span>
            )}
            {' · grip '}{CORNER_IDS.map((id) => (
              <span key={id} className={cur.utilization[id] > 1 ? 'bad-text' : cur.utilization[id] > 0.9 ? 'warn-text' : ''}> {id} {fmt(cur.utilization[id] * 100, 0)}%</span>
            ))}
            {cur.findings.length > 0 && <span style={{ color: SEV_COLOR[cur.severity] }}> · {cur.findings[0]}</span>}
          </div>
        ) : (
          <div className="small-text muted">
            {pb.error ? `Playback failed: ${pb.error}` : stale ? 'The design changed: Play recomputes.' : 'Play (or Space) drives the car through the test: over time (body motion, wheel hop, dampers) when the test has Ride over time on, otherwise state to state.'}
          </div>
        )}
      </div>
    </div>
  );
}

const MAP_COLORS = ['#8ab4f8', '#c3a6ff', '#7fd1c7', '#f2a7c3', '#e6c07b'];

/**
 * Top view of a test while building it: each segment drawn from its distance, path and radius, chained
 * from the start (white dot). Click a segment to edit it. Colored by the last run's result when it's
 * current, otherwise by segment; bumps / potholes are marked, rough road is dashed.
 */
export function SegmentMap({ test, selected, onSelect, severities }: {
  test: TestDesign; selected: string | null; onSelect: (id: string) => void; severities?: (Severity | undefined)[];
}) {
  const disp = useDisplay();
  const paths = useMemo(() => trackPath(test.segments.map((sg) => ({
    distance: Math.max(sg.distance.value, 0), path: sg.path, radius: Math.max(sg.radius.value, 0.1),
  }))), [test.segments]);
  const pts = paths.flat();
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const W = 300, H = 150, pad = 14;
  const k = Math.min((W - 2 * pad) / Math.max(maxX - minX, 1), (H - 2 * pad) / Math.max(maxY - minY, 1));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const px = (x: number) => W / 2 + (x - cx) * k;
  const py = (y: number) => H / 2 - (y - cy) * k;
  const d = (ps: { x: number; y: number }[]) => ps.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
  // Scale bar: a round length about a quarter of the width.
  const target = (W / 4) / k;
  const mag = 10 ** Math.floor(Math.log10(Math.max(target, 1e-6)));
  const bar = [1, 2, 5, 10].map((m) => m * mag).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  const at = (seg: number, sAlong: number) => {
    const ps = paths[seg]!;
    const total = test.segments[seg]!.distance.value || 1;
    const idx = Math.min(ps.length - 1, Math.max(0, Math.round((sAlong / total) * (ps.length - 1))));
    return ps[idx]!;
  };
  const end = pts[pts.length - 1]!;
  return (
    <svg className="segment-map" viewBox={`0 0 ${W} ${H}`} aria-label="Track map of the test">
      {paths.map((ps, i) => {
        const seg = test.segments[i]!;
        const sev = severities?.[i];
        const color = sev ? SEV_COLOR[sev] : MAP_COLORS[i % MAP_COLORS.length];
        const sel = seg.id === selected;
        const mid = ps[Math.floor(ps.length / 2)]!;
        return (
          <g key={seg.id} className="seg-path" onClick={() => onSelect(seg.id)}>
            <title>{`${i + 1}. ${seg.name}`}</title>
            <path d={d(ps)} stroke="transparent" strokeWidth={12} fill="none" />
            {sel && <path d={d(ps)} stroke="#ffffff" strokeWidth={7} strokeLinecap="round" fill="none" opacity={0.85} />}
            <path d={d(ps)} stroke={color} strokeWidth={sel ? 4 : 3} strokeLinecap="round" fill="none" strokeDasharray={seg.rough.on ? '4 3' : undefined} />
            {seg.features.map((f) => {
              const p = at(i, f.at.value);
              return <circle key={f.id} cx={px(p.x)} cy={py(p.y)} r={3} fill={f.kind === 'bump' ? '#ffb703' : '#4cc9f0'} stroke="#16191e" strokeWidth={0.8} />;
            })}
            <text x={px(mid.x)} y={py(mid.y) - 6} className="seg-map-num" textAnchor="middle">{i + 1}</text>
          </g>
        );
      })}
      <circle cx={px(0)} cy={py(0)} r={4} fill="#ffffff" stroke="#16191e" strokeWidth={1}><title>Start</title></circle>
      <g transform={`translate(${px(end.x)},${py(end.y)}) rotate(${(-end.heading * 180) / Math.PI})`}>
        <polygon points="6,0 -4,-4 -4,4" fill="#ffffff" stroke="#16191e" strokeWidth={0.8} />
      </g>
      <g transform={`translate(${W - pad - bar * k},${H - 6})`}>
        <line x1={0} y1={0} x2={bar * k} y2={0} stroke="#9aa3ad" strokeWidth={1.5} />
        <text x={(bar * k) / 2} y={-3} className="seg-map-scale" textAnchor="middle">{disp.format(bar, 'm', 0)}</text>
      </g>
    </svg>
  );
}
