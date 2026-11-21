/**
 * Test playback (Phase A): the car driven through the test frame by frame (every 0.1 s), each frame a
 * steady state. Play / pause, scrub, speed; a top-view map of the track colored by Pass / Warning /
 * Fail. Each frame poses the 3D car (the Vehicle view's accelerations, grade, bank and wheel bumps).
 */
import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import type { PlaybackFrame } from '../../core/tests/run';
import { CORNER_IDS } from '../../core/vehicle/vehicle';
import { useApp } from '../store';
import { buildVehicleProblem, runPlaybackJob } from '../optimizer';
import { segmentSpec, type TestDesign } from '../tests';
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
  s.set('testView', null);
}

async function computeFrames(test: TestDesign) {
  const s = useApp.getState();
  usePlayback.setState({ computing: true, error: null, playing: false, testId: test.id, from: { geom: s.geom, corners: s.corners } });
  try {
    const { problem } = buildVehicleProblem(s);
    const frames = await runPlaybackJob(problem, test.segments.map((sg) => segmentSpec(sg, test))).done;
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
    <svg className="track-map" viewBox={`0 0 ${W} ${H}`} aria-label="Track map">
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
    const f = pb.from as { geom: unknown; corners: unknown } | null;
    return !!f && pb.testId === test?.id && (f.geom !== geom || f.corners !== corners);
  }, [pb.from, pb.testId, test?.id, geom, corners]);

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
    if (!test) return;
    let fs = frames;
    if (!fs.length || stale) fs = await computeFrames(test);
    if (!fs.length) return;
    const st = usePlayback.getState();
    if (st.t >= (fs[fs.length - 1]?.t ?? 0)) usePlayback.setState({ t: 0 });
    usePlayback.setState({ playing: true });
  };
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
            ? <button onClick={() => void play()} disabled={!test || pb.computing} title={frames.length && !stale ? 'Play' : 'Drive the car through the test (computes every 0.1 s)'}>{pb.computing ? 'Preparing…' : '▶ Play'}</button>
            : <button onClick={() => usePlayback.setState({ playing: false })}>❚❚ Pause</button>}
          <input type="range" min={0} max={total || 1} step={0.05} value={Math.min(pb.t, total)} disabled={!frames.length} onChange={(e) => seek(Number(e.target.value))} className="playback-slider" />
          <span className="mono small-text">{fmt(Math.min(pb.t, total), 1)} / {fmt(total, 1)} s</span>
          <select value={pb.rate} onChange={(e) => usePlayback.setState({ rate: Number(e.target.value) })} title="Playback speed">
            {[0.25, 0.5, 1, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </div>
        {cur && test ? (
          <div className="small-text playback-hud">
            <b>{cur.segment + 1}. {test.segments[cur.segment]?.name}</b> · {disp.format(cur.speed, 'm/s', 0)} · lateral {fmt(cur.ay, 2)} g · long. {fmt(cur.ax, 2)} g
            {' · grip '}{CORNER_IDS.map((id) => (
              <span key={id} className={cur.utilization[id] > 1 ? 'bad-text' : cur.utilization[id] > 0.9 ? 'warn-text' : ''}> {id} {fmt(cur.utilization[id] * 100, 0)}%</span>
            ))}
            {cur.findings.length > 0 && <span style={{ color: SEV_COLOR[cur.severity] }}> · {cur.findings[0]}</span>}
          </div>
        ) : (
          <div className="small-text muted">
            {pb.error ? `Playback failed: ${pb.error}` : stale ? 'The design changed: Play recomputes.' : 'Play drives the car through the test. Steady states for now: the body moves state to state, without transients (Phase B).'}
          </div>
        )}
      </div>
    </div>
  );
}
