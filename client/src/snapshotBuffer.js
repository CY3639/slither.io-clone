/**
 * Snapshot interpolation. The server sends state at 15 Hz; the client renders ~110 ms in the past
 * and blends the two snapshots around that time, so motion is smooth at 60 fps despite the
 * lower network rate and arrival jitter.
 *
 * Server time is mapped to local time with offset = min(localReceive - serverTs) over recent
 * snapshots (minimum one-way delay plus clock difference), which is robust to jitter.
 */
function SnapshotBuffer(delayMs) {
    this.delayMs = delayMs;
    this.snaps = [];
    this.offsets = [];
    this.offset = null;
}

/**
 * Bodies arrive delta-encoded (first point absolute, then offsets) at half resolution: sections
 * 0, 2, 4, ... plus the tail when the length is even. Rebuild all `length` sections, filling each
 * skipped section with the midpoint of its neighbours.
 */
SnapshotBuffer.decodeBody = function (p, length) {
    var k;
    for (k = 2; k < p.length; k++) p[k] += p[k - 2];
    var last = length - 1;
    var full = new Array(length * 2);
    for (var i = 0; i <= last; i += 2) {
        full[i * 2] = p[i];
        full[i * 2 + 1] = p[i + 1];
    }
    if (last % 2 === 1) {
        full[last * 2] = p[p.length - 2];
        full[last * 2 + 1] = p[p.length - 1];
    }
    for (var j = 1; j < last; j += 2) {
        full[j * 2] = (full[(j - 1) * 2] + full[(j + 1) * 2]) / 2;
        full[j * 2 + 1] = (full[(j - 1) * 2 + 1] + full[(j + 1) * 2 + 1]) / 2;
    }
    return full;
};

SnapshotBuffer.prototype = {
    reset: function () {
        this.snaps = [];
        this.offsets = [];
        this.offset = null;
    },

    push: function (snap) {
        var off = Date.now() - snap.ts;
        this.offsets.push(off);
        if (this.offsets.length > 45) this.offsets.shift();
        this.offset = Math.min.apply(null, this.offsets);

        snap.byId = {};
        for (var i = 0; i < snap.sn.length; i++) {
            var s = snap.sn[i];
            s.p = SnapshotBuffer.decodeBody(s.p, s.l);
            snap.byId[s.i] = s;
        }
        this.snaps.push(snap);
        if (this.snaps.length > 30) this.snaps.shift();
    },

    renderTime: function () {
        return Date.now() - this.offset - this.delayMs;
    },

    /** Snapshots whose time has been reached and whose food deltas are not yet applied. */
    takeDue: function (renderTs) {
        var due = [];
        for (var i = 0; i < this.snaps.length; i++) {
            var s = this.snaps[i];
            if (!s.applied && s.ts <= renderTs) {
                s.applied = true;
                due.push(s);
            }
        }
        return due;
    },

    /** Returns { snakes: [...], me, focus } interpolated at renderTs, or null if no data yet. */
    sample: function (renderTs) {
        var snaps = this.snaps;
        if (!snaps.length) return null;
        var a = null;
        var b = null;
        for (var i = snaps.length - 1; i >= 0; i--) {
            if (snaps[i].ts <= renderTs) {
                a = snaps[i];
                b = snaps[i + 1] || null;
                break;
            }
        }
        if (!a) return this.toFrame(snaps[0], null, 0);
        if (!b) return this.toFrame(a, null, 0);
        var t = (renderTs - a.ts) / (b.ts - a.ts);
        return this.toFrame(b, a, t < 0 ? 0 : t > 1 ? 1 : t);
    },

    toFrame: function (target, prev, t) {
        var out = [];
        for (var i = 0; i < target.sn.length; i++) {
            var s = target.sn[i];
            var p = prev && prev.byId[s.i];
            if (!p) {
                // Snake only in the newer snapshot: show it as-is.
                if (!prev || t >= 0.5) out.push({ id: s.i, name: s.n, color: s.c, human: s.h, scale: s.r / 1000, boost: s.b, pts: s.p });
                continue;
            }
            var n = s.p.length;
            var m = p.p.length;
            var pts = new Array(n);
            for (var k = 0; k < n; k++) pts[k] = k < m ? p.p[k] + (s.p[k] - p.p[k]) * t : s.p[k];
            out.push({
                id: s.i,
                name: s.n,
                color: s.c,
                human: s.h,
                scale: (p.r + (s.r - p.r) * t) / 1000,
                boost: s.b,
                pts: pts
            });
        }
        var src = prev && t < 0.5 ? prev : target;
        var focus = prev
            ? { x: prev.fx + (target.fx - prev.fx) * t, y: prev.fy + (target.fy - prev.fy) * t }
            : { x: target.fx, y: target.fy };
        return { snakes: out, me: src.me, focus: focus };
    },

    latest: function () {
        return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
    }
};
