/**
 * Camera memory across the workspaces (Corner, Vehicle, Tests static / dynamic): each view keeps where its
 * camera was, and the last camera is kept in the vehicle's own frame, so the next view can start from the same
 * viewpoint around the car and sweep from there to where it was left (or to its default the first time).
 * Not saved with the project: it lasts while the page is open.
 */
import * as THREE from 'three';
import { isFront, isLeft, type CornerId } from '../../core/vehicle/vehicle';

/**
 * A camera: where it is, what it looks at, and how much it shows there (`height`: the visible height at the
 * target, mm). The height is what carries the scale from one view to the next, so an orthographic view
 * (scale = its zoom) and a perspective one (scale = its distance) hand over without a jump in size.
 */
export interface CamPose { pos: THREE.Vector3; target: THREE.Vector3; height?: number }

const views = new Map<string, CamPose>();
/** The last camera of any view, in the vehicle frame (mm; X left, Y up from the chassis datum, Z forward). */
let lastInVehicle: CamPose | null = null;
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __camMem?: unknown }).__camMem = () => ({ views: Object.fromEntries([...views].map(([k, v]) => [k, [v.pos.toArray().map(Math.round), v.target.toArray().map(Math.round), v.height && Math.round(v.height)]])), last: lastInVehicle && [lastInVehicle.pos.toArray().map(Math.round), lastInVehicle.target.toArray().map(Math.round), lastInVehicle.height && Math.round(lastInVehicle.height)] });

const copy = (p: CamPose): CamPose => ({ pos: p.pos.clone(), target: p.target.clone(), ...(p.height !== undefined ? { height: p.height } : {}) });

/** `own`: the pose as the view keeps it, when not the scene's (a chase camera keeps it in the car's frame). */
export function rememberView(key: string, pose: CamPose, toVehicle: (v: THREE.Vector3) => THREE.Vector3, own?: CamPose): void {
  views.set(key, copy(own ?? pose));
  lastInVehicle = { pos: toVehicle(pose.pos.clone()), target: toVehicle(pose.target.clone()), ...(pose.height !== undefined ? { height: pose.height } : {}) };
}
export const recallView = (key: string): CamPose | null => { const p = views.get(key); return p ? copy(p) : null; };
/** The last camera mapped into a view's own frame (null on the first view shown). */
export function lastCamera(fromVehicle: (v: THREE.Vector3) => THREE.Vector3): CamPose | null {
  return lastInVehicle ? { pos: fromVehicle(lastInVehicle.pos.clone()), target: fromVehicle(lastInVehicle.target.clone()), ...(lastInVehicle.height !== undefined ? { height: lastInVehicle.height } : {}) } : null;
}

type AnyCamera = THREE.Camera & { isOrthographicCamera?: boolean; zoom?: number; fov?: number };
const tanHalf = (cam: AnyCamera) => Math.tan(((cam.fov ?? 45) * Math.PI) / 360);

/** How much a camera shows at its target: orthographic, the view height ÷ zoom; perspective, 2 d tan(fov / 2). */
export function viewHeight(cam: AnyCamera, pos: THREE.Vector3, target: THREE.Vector3, viewportHeight: number): number {
  return cam.isOrthographicCamera ? viewportHeight / (cam.zoom || 1) : 2 * pos.distanceTo(target) * tanHalf(cam);
}

/**
 * Where to put this camera to show a pose: same direction to the target; perspective, at the distance that
 * shows its height; orthographic, the zoom that shows it (the distance only has to clear what's in view, at
 * least `orthoDistance`).
 */
export function placeFor(pose: CamPose, cam: AnyCamera, viewportHeight: number, orthoDistance = 0): { pos: THREE.Vector3; zoom?: number } {
  const dir = pose.pos.clone().sub(pose.target);
  const d0 = dir.length() || 1;
  dir.divideScalar(d0);
  if (!pose.height) return { pos: pose.pos.clone() };
  if (cam.isOrthographicCamera) return { pos: pose.target.clone().addScaledVector(dir, Math.max(d0, orthoDistance)), zoom: viewportHeight / pose.height };
  return { pos: pose.target.clone().addScaledVector(dir, pose.height / (2 * tanHalf(cam))) };
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
