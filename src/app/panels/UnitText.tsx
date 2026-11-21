/** Unit-aware bits of text (see units.ts): a unit label, and a base-unit number shown in display units. */
import { useConversion, useDisplay } from '../units';

/** The display unit for a base unit string, e.g. "mm" → "in". */
export function UnitLabel({ unit }: { unit: string }) {
  return <>{useConversion(unit).unit}</>;
}

/** A formatted base-unit number ("12.5") shown in display units, with or without the unit. */
export function Num({ text, unit, withUnit = false }: { text: string; unit: string; withUnit?: boolean }) {
  const d = useDisplay().text(text, unit);
  return <>{d.text}{withUnit ? ` ${d.unit}` : ''}</>;
}
