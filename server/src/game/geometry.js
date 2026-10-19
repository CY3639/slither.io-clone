export const TAU = Math.PI * 2;

/** Wrap an angle into [-PI, PI). */
export function normalizeAngle(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
}

export function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}
