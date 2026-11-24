/**
 * Tires of other sizes (round 3, R7; docs/MATH.md § Tire choice).
 *
 * A tire's Magic Formula coefficients are mostly dimensionless (friction levels, curve shapes, load and
 * camber sensitivities), so a measured tire can stand in for a similar one of another size: keep them and
 * move what carries the size.
 * - Nominal load FNOMIN scales with the load the size can carry at the same pressure, by the Tire & Rim
 *   Association load formula's shape: L ∝ S^1.39 · (D_rim + S), S = the section's size (mean of its width
 *   and height). At the same actual load a bigger tire then sits lower on its load-sensitivity curve, so it
 *   grips a little more (and its cornering stiffness, ∝ FNOMIN, grows).
 * - Radius, width, rim radius: the new size's (relaxation lengths and the aligning moment scale with the
 *   radius in MF 6.x). Vertical stiffness: with the load capacity over the section height (the same share
 *   of the sidewall squashed at the nominal load).
 * The further the size is from the measured one, the rougher the guess: `change` says how far.
 */
import type { TirModel } from './tir';

export interface TireDims {
  /** Outer diameter, section width and rim diameter, mm. */
  outer: number;
  width: number;
  rim: number;
}

const sectionSize = (d: TireDims) => (d.width + (d.outer - d.rim) / 2) / 2;

/** How much more load the size `to` carries than `from` at the same pressure. */
export function loadCapacityRatio(from: TireDims, to: TireDims): number {
  const L = (d: TireDims) => sectionSize(d) ** 1.39 * (d.rim + sectionSize(d));
  return L(to) / Math.max(L(from), 1e-9);
}

/** The relative size change between two tires (the larger of the width and outer-diameter changes). */
export const sizeChange = (from: TireDims, to: TireDims) => Math.max(Math.abs(to.width / from.width - 1), Math.abs(to.outer / from.outer - 1));

/** A measured tire (.tir) approximated at another size. */
export function scaleTir(m: TirModel, from: TireDims, to: TireDims, label: string): { model: TirModel; change: number } {
  const k = loadCapacityRatio(from, to);
  const hFrom = (from.outer - from.rim) / 2, hTo = (to.outer - to.rim) / 2;
  const p = { ...m.p };
  if (p.FNOMIN !== undefined) p.FNOMIN = p.FNOMIN * k;
  if (p.VERTICAL_STIFFNESS !== undefined) p.VERTICAL_STIFFNESS = (p.VERTICAL_STIFFNESS * k * hFrom) / Math.max(hTo, 1e-9);
  p.UNLOADED_RADIUS = to.outer / 2000;
  p.WIDTH = to.width / 1000;
  p.RIM_RADIUS = to.rim / 2000;
  return { model: { ...m, p, fnomin: m.fnomin * k, name: `${m.name.replace(/ \(approximated as .*\)$/, '')} (approximated as ${label})` }, change: sizeChange(from, to) };
}

/**
 * Rough tire + wheel mass, kg, from the size (calibrated to a 225/45R17 on a 17 × 7.5" alloy, ≈ 10 kg +
 * 9.5 kg): tread ∝ width × diameter, sidewalls ∝ D² − D_rim², wheel ∝ rim diameter × rim width.
 */
export function tireWheelMass(d: TireDims, rimWidth = 0.8 * d.width): number {
  const tire = 3.5e-5 * d.width * d.outer + 2.32e-5 * (d.outer * d.outer - d.rim * d.rim);
  const wheel = (9.5 * (d.rim * rimWidth)) / (431.8 * 190.5);
  return tire + wheel;
}
