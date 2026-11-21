import type { ReactNode } from 'react';
import type { Field } from '../store';
import { ValueInput } from './ValueInput';
import { useDisplay } from '../units';

export interface Row {
  label: string;
  /** Editable field, or a plain read-only value. */
  field?: Field;
  value?: string;
  unit: string;
  onCommit?: (text: string) => void;
  hint?: string;
  /** Lock key (see locks.ts): shows a lock toggle and lets the Locks tab find this row. */
  lockKey?: string;
}

/** Label / value / unit rows; editable when a field + onCommit is given. */
export function FieldRows({ rows }: { rows: Row[] }) {
  const d = useDisplay();
  return (
    <table className="field-rows">
      <tbody>
        {rows.map((r) => {
          const shown = d.text(r.value ?? '—', r.unit);
          return (
            <tr key={r.label} title={r.hint} data-lock-key={r.lockKey}>
              <td>{r.label}</td>
              <td className="num">
                {r.field && r.onCommit
                  ? <ValueInput field={r.field} unit={r.unit} onCommit={r.onCommit} lockKey={r.lockKey} />
                  : <span className="readonly">{shown.text}</span>}
              </td>
              <td className="unit">{shown.unit}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Collapsible section used across the inspector and readouts. */
export function Section({ title, children, open = true, extra }: { title: string; children: ReactNode; open?: boolean; extra?: ReactNode }) {
  return (
    <details className="section" open={open}>
      <summary><span>{title}</span>{extra}</summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

export const fmt = (v: number | null | undefined, digits = 2) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return '∞';
  const s = v.toFixed(digits);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s; // no "-0"
};

/** A transient Field for editing a derived value (shows the current value, commits text). */
export const derivedField = (value: number, digits = 2): Field => ({ text: String(Number(value.toFixed(digits))), value });
