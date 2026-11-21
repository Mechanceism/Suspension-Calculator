import { useEffect, useState } from 'react';
import { useApp, type Field } from '../store';
import { parseValue } from '../../core/units/units';
import { useConversion, isPlainNumber, toDisplay, fromDisplay, digitsFor } from '../units';

/** Lock toggle for one or more lock keys (locked = every key locked). */
export function LockButton({ keys, title }: { keys: string[]; title?: string }) {
  const locked = useApp((s) => keys.length > 0 && keys.every((k) => s.locks[k]));
  const partial = useApp((s) => !locked && keys.some((k) => s.locks[k]));
  const setLocks = useApp((s) => s.setLocks);
  return (
    <button
      type="button"
      className={`lock-btn${locked ? ' on' : partial ? ' partial' : ''}`}
      onClick={() => setLocks(keys, !locked)}
      title={title ?? (locked ? 'Locked: the optimizer must keep this. Click to unlock.' : 'Lock so the optimizer keeps this value')}
      aria-pressed={locked}
    >
      {locked ? '🔒' : '🔓'}
    </button>
  );
}

/**
 * Text entry with unit parsing. Commits on Enter or blur. Keeps the user's text (e.g. "5in");
 * the tooltip shows the parsed base value. Plain numbers are shown, and read when typed, in the
 * chosen display unit (Units menu); the value is stored in base units. With `lockKey`, shows a lock toggle; a locked value can
 * still be typed, but it's highlighted so it's clear the optimizer won't change it.
 */
export function ValueInput({ field, unit, onCommit, width, lockKey, locked: lockedProp }: {
  field: Field; unit: string; onCommit: (text: string) => void; width?: number;
  lockKey?: string;
  /** Show as locked without a toggle (e.g. a coordinate locked through its part). */
  locked?: boolean;
}) {
  const conv = useConversion(unit);
  // What the box shows: typed text with a unit stays as typed; plain numbers follow the display unit.
  const shown = !conv.identity && !field.error && isPlainNumber(field.text)
    ? String(Number(toDisplay(field.value, conv).toFixed(digitsFor(3, conv))))
    : field.text;
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const lockedByKey = useApp((s) => (lockKey ? !!s.locks[lockKey] : false));
  const locked = lockedByKey || !!lockedProp;
  const commit = () => {
    if (text === shown) return;
    if (!conv.identity && isPlainNumber(text)) {
      // A plain number is in the display unit: store it as a base-unit number.
      const r = parseValue(text, 'ratio');
      if (r.ok) { onCommit(String(Number(fromDisplay(r.value, conv).toFixed(6)))); return; }
    }
    onCommit(text);
  };
  const input = (
    <input
      className={`value-input${field.error ? ' invalid' : ''}${locked ? ' locked' : ''}`}
      style={width ? { width } : undefined}
      value={text}
      title={field.error ?? `${Number(field.value.toFixed(4))} ${unit}${conv.identity ? '' : ` = ${Number(toDisplay(field.value, conv).toFixed(digitsFor(4, conv)))} ${conv.unit}`}${locked ? ' · locked' : ''}`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setText(shown); (e.target as HTMLInputElement).blur(); }
      }}
      spellCheck={false}
    />
  );
  if (!lockKey) return input;
  return <span className="vi-wrap">{input}<LockButton keys={[lockKey]} /></span>;
}
