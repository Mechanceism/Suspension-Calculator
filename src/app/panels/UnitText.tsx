/** Unit-aware bits of text (see units.ts): a unit label, and a base-unit number shown in display units. */
import { useConversion, useDisplay } from '../units';

/** The display unit for a base unit string, e.g. "mm" → "in". */
export function UnitLabel({ unit }: { unit: string }) {
  return <>{useConversion(unit).unit}</>;
}

/** A base-unit number shown in display units with its unit ("26.0" mm → "1.02 in"); — when missing. */
export function Val({ v, unit, digits = 1 }: { v: number | null | undefined; unit: string; digits?: number }) {
  const disp = useDisplay();
  return <>{v === null || v === undefined ? '—' : disp.format(v, unit, digits)}</>;
}

/** A sentence written in base units (from the core: findings, notes, messages) in the display units. */
export function Local({ text }: { text: string }) {
  return <>{useDisplay().local(text)}</>;
}

/** A formatted base-unit number ("12.5") shown in display units, with or without the unit. */
export function Num({ text, unit, withUnit = false }: { text: string; unit: string; withUnit?: boolean }) {
  const d = useDisplay().text(text, unit);
  return <>{d.text}{withUnit ? ` ${d.unit}` : ''}</>;
}
