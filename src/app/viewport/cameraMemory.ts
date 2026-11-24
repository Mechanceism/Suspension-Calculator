/**
 * Camera memory across the workspaces (Corner, Vehicle, Tests static / dynamic): each view keeps where its
 * camera was, and the last camera is kept in the vehicle's own frame, so the next view can start from the same
 * viewpoint around the car and sweep from there to where it was left (or to its default the first time).
 * Not saved with the project: it lasts while the page is open.
 */
import * as THREE from 'three';
import { isFront, isLeft, type CornerId } from '../../core/vehicle/vehicle';

export interface CamPose { pos: THREE.Vector3; target: THREE.Vector3; zoom?: number }

const views = new Map<string, CamPose>();
/** The last camera of any view, in the vehicle frame (mm; X left, Y up from the chassis datum, Z forward). */
let lastInVehicle: CamPose | null = null;
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __camMem?: unknown }).__camMem = () => ({ views: Object.fromEntries([...views].map(([k, v]) => [k, [v.pos.toArray().map(Math.round), v.target.toArray().map(Math.round), v.zoom]])), last: lastInVehicle && [lastInVehicle.pos.toArray().map(Math.round), lastInVehicle.target.toArray().map(Math.round)] });

const copy = (p: CamPose): CamPose => ({ pos: p.pos.clone(), target: p.target.clone(), ...(p.zoom !== undefined ? { zoom: p.zoom } : {}) });

/** `own`: the pose as the view keeps it, when not the scene's (a chase camera keeps it in the car's frame). */
export function rememberView(key: string, pose: CamPose, toVehicle: (v: THREE.Vector3) => THREE.Vector3, own?: CamPose): void {
  views.set(key, copy(own ?? pose));
  lastInVehicle = { pos: toVehicle(pose.pos.clone()), target: toVehicle(pose.target.clone()), ...(pose.zoom !== undefined ? { zoom: pose.zoom } : {}) };
}
export const recallView = (key: string): CamPose | null => { const p = views.get(key); return p ? copy(p) : null; };
/** The last camera mapped into a view's own frame (null on the first view shown). */
export function lastCamera(fromVehicle: (v: THREE.Vector3) => THREE.Vector3): CamPose | null {
  return lastInVehicle ? { pos: fromVehicle(lastInVehicle.pos.clone()), target: fromVehicle(lastInVehicle.target.clone()), ...(lastInVehicle.zoom !== undefined ? { zoom: lastInVehicle.zoom } : {}) } : null;
}

/** The Corner view draws the active corner in its own frame (as a front-left corner): to / from the vehicle frame. */
export function cornerFrame(id: CornerId, wheelbase: number) {
  const sx = isLeft(id) ? 1 : -1, dz = isFront(id) ? 0 : -wheelbase;
  return {
    toVehicle: (v: THREE.Vector3) => v.set(v.x * sx, v.y, v.z + dz),
    fromVehicle: (v: THREE.Vector3) => v.set(v.x * sx, v.y, v.z - dz),
  };
}
export const sameFrame = { toVehicle: (v: THREE.Vector3) => v, fromVehicle: (v: THREE.Vector3) => v };

/** Smooth 0 → 1 (ease in and out). */
export const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
