/**
 * F29 (round 5): Compare → Character — the setup's character. Each axle's characteristics and adjustments (and the
 * car's) set against the typical ranges per kind of driving; how well the car matches each kind, front, rear and
 * overall; the snapshot's alongside when there is one. The reference ranges are editable (kept in this browser).
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { modelSnapshot } from '../project';
import { characterValues, useCharacterRefs, setReference, resetReferences } from '../character';
import {
  STYLES, STYLE_LABEL, CHAR_META, ROW_KEYS, styleMatches, characterSummary, outside,
  type RowKey, type Style, type Where, type CharKey, type Range,
} from '../../core/vehicle/character';
import type { Snapshot } from '../snapshots';
import { Section, fmt } from './FieldRows';

export const STYLE_COLOR: Record<Style, string> = {
  track: '#e5484d', road: '#3e8ed0', offroad: '#b0793f', drift: '#a26be0', drag: '#e9a23b', towing: '#2fa58f',
};
const WHERE_LABEL: Record<Where, string> = { front: 'Front', rear: 'Rear', car: 'Car' };
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)} %`);

/** The current design's values, worked out again only when the model changes (not on view / slider changes). */
function useCurrentValues() {
  const key = useApp((s) => modelSnapshot(s));
  const [v, setV] = useState<ReturnType<typeof characterValues> | null>(null);
  useEffect(() => {
    // After the paint: the whole-car solve takes a moment.
    const id = setTimeout(() => setV(characterValues(useApp.getState())), 30);
    return () => clearTimeout(id);
  }, [key]);
  return v;
}

/** A row's strip: each kind's range as a band on one scale, the current value (solid) and the snapshot's (dashed). */
function Strip({ row, a, b }: { row: RowKey; a: number | null | undefined; b: number | null | undefined }) {
  const refs = useCharacterRefs((s) => s.refs);
  const ranges = STYLES.map((st) => [st, refs[st][row]] as const).filter((x): x is readonly [Style, Range] => !!x[1]);
  const xs = [...ranges.flatMap(([, r]) => r), ...[a, b].filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x))];
  if (!xs.length) return null;
  let lo = Math.min(...xs), hi = Math.max(...xs);
  const pad = 0.06 * Math.max(hi - lo, 1e-6);
  lo -= pad; hi += pad;
  const at = (x: number) => `${(100 * (x - lo)) / (hi - lo)}%`;
  const H = 4, gap = 1;
  return (
    <div className="char-strip" style={{ height: ranges.length * (H + gap) + 2 }} title={ranges.map(([st, r]) => `${STYLE_LABEL[st]}: ${r[0]} … ${r[1]}`).join('\n')}>
      {ranges.map(([st, r], i) => (
        <div key={st} className="char-band" style={{ left: at(Math.min(...r)), width: `calc(${at(Math.max(...r))} - ${at(Math.min(...r))})`, top: 1 + i * (H + gap), height: H, background: STYLE_COLOR[st] }} />
      ))}
      {b !== null && b !== undefined && Number.isFinite(b) && <div className="char-mark snap" style={{ left: at(b) }} />}
      {a !== null && a !== undefined && Number.isFinite(a) && <div className="char-mark" style={{ left: at(a) }} />}
    </div>
  );
}

const value = (k: CharKey, v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : fmt(v, CHAR_META[k].digits));

export function CharacterPanel({ snap }: { snap: Snapshot | null }) {
  const refs = useCharacterRefs((s) => s.refs);
  const [edit, setEdit] = useState<Style>('track');
  const a = useCurrentValues();
  const b = useMemo(() => (snap ? characterValues(snap.design) : null), [snap]);
  const ma = useMemo(() => (a ? styleMatches(a, refs) : null), [a, refs]);
  const mb = useMemo(() => (b ? styleMatches(b, refs) : null), [b, refs]);
  if (!a || !ma) return <section className="panel compare-panel"><h2>Setup character</h2><p className="muted">Working it out…</p></section>;
  const rows = ROW_KEYS.filter((k) => a[k] !== undefined || (b && b[k] !== undefined));
  return (
    <section className="panel compare-panel">
      <h2>Setup character</h2>
      <p className="hint">Each axle's characteristics and adjustments against the ranges typical for each kind of driving, and how well the car matches each: 100 % at the middle of a range, 50 % at its ends, 0 a whole range-width from the middle. A car tuned for two kinds should sit between them. The ranges are typical values, rounded and wide — a guide, not rules (edit them below).</p>
      <p><b>Current design:</b> {characterSummary(ma)}{mb && <><br /><b>Snapshot “{snap!.name}”:</b> {characterSummary(mb)}</>}</p>
      <Section title="Match by kind of driving">
        <table className="opt-table char-match">
          <thead><tr><th>Kind</th><th>Front</th><th>Rear</th><th>Car</th><th>Overall</th>{mb && <th title="The snapshot's overall match">Snap.</th>}</tr></thead>
          <tbody>
            {ma.map((m, i) => (
              <tr key={m.style}>
                <td className="nowrap"><span className="char-dot" style={{ background: STYLE_COLOR[m.style] }} /> {STYLE_LABEL[m.style]}</td>
                <td className="num nowrap">{pct(m.front)}</td>
                <td className="num nowrap">{pct(m.rear)}</td>
                <td className="num nowrap">{pct(m.car)}</td>
                <td className="char-bar-cell"><div className="char-bar" style={{ width: `${Math.round((m.overall ?? 0) * 100)}%`, background: STYLE_COLOR[m.style] }} /><span>{pct(m.overall)}</span></td>
                {mb && <td className="num nowrap">{pct(mb[i]!.overall)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Characteristics">
        <p className="hint">Under each: the typical range of each kind as a band (colors as above; hover for the numbers), the current value ┃ and the snapshot's ┆.</p>
        <table className="opt-table char-rows">
          <thead><tr><th>Characteristic</th><th className="num">Current</th>{b && <th className="num">Snapshot</th>}</tr></thead>
          <tbody>
            {(['front', 'rear', 'car'] as Where[]).map((w) => {
              const rs = rows.filter((k) => k.startsWith(`${w}.`));
              if (!rs.length) return null;
              return (
                <Fragment key={w}>
                  <tr className="char-group"><td colSpan={b ? 3 : 2}>{WHERE_LABEL[w]}</td></tr>
                  {rs.map((k) => {
                    const c = k.split('.')[1] as CharKey, m = CHAR_META[c];
                    const va = a[k];
                    const fits = STYLES.filter((st) => refs[st][k] && va !== null && va !== undefined && Number.isFinite(va) && outside(va, refs[st][k]!) === 0);
                    return (
                      <Fragment key={k}>
                        <tr title={m.hint} className="char-row">
                          <td>{m.label} <span className="unit">{m.unit}</span></td>
                          <td className="num">{value(c, va)}</td>
                          {b && <td className="num">{value(c, b[k])}</td>}
                        </tr>
                        <tr className="char-strip-row">
                          <td colSpan={b ? 3 : 2}>
                            <Strip row={k} a={va} b={b?.[k]} />
                            <span className="small-text muted char-fits">within: {fits.length ? fits.map((st) => <span key={st} className="char-dot" title={STYLE_LABEL[st]} style={{ background: STYLE_COLOR[st] }} />) : 'none'}</span>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section title="Reference ranges" open={false}>
        <p className="hint">Typical values per kind of driving, rounded and wide — the kind of values setup guides give, not checked item by item against sources. Pick a kind and edit its ranges; kept in this browser for every design.</p>
        <div className="jm-row">
          {STYLES.map((st) => (
            <button key={st} className={`chip${st === edit ? ' on' : ''}`} onClick={() => setEdit(st)}><span className="char-dot" style={{ background: STYLE_COLOR[st] }} />{STYLE_LABEL[st]}</button>
          ))}
        </div>
        <table className="opt-table char-refs">
          <thead><tr><th>{STYLE_LABEL[edit]}</th><th>Min</th><th>Max</th></tr></thead>
          <tbody>
            {ROW_KEYS.map((k) => {
              const [w, c] = k.split('.') as [Where, CharKey];
              const r = refs[edit][k];
              const set = (i: 0 | 1, text: string) => {
                const n = Number(text.replace(/−/g, '-'));
                if (!r || !Number.isFinite(n)) return;
                const next: Range = i === 0 ? [n, r[1]] : [r[0], n];
                setReference(edit, k, [Math.min(...next), Math.max(...next)] as Range);
              };
              return (
                <tr key={`${edit}.${k}`}>
                  <td>{WHERE_LABEL[w]} {/^[A-Z]{2,}/.test(CHAR_META[c].label) ? CHAR_META[c].label : CHAR_META[c].label.toLowerCase()} <span className="unit">{CHAR_META[c].unit}</span></td>
                  <td><input key={`${r?.[0]}`} type="number" style={{ width: 62 }} defaultValue={r?.[0]} onBlur={(e) => set(0, e.target.value)} /></td>
                  <td><input key={`${r?.[1]}`} type="number" style={{ width: 62 }} defaultValue={r?.[1]} onBlur={(e) => set(1, e.target.value)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="jm-row"><button className="chip" onClick={resetReferences}>Default ranges</button></div>
      </Section>
    </section>
  );
}
