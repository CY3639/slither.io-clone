// Uniform-grid spatial hash. Collision and food queries only look at nearby cells, so a
// 50-snake world stays well under a millisecond per tick instead of O(sections²).

function cellKey(cx, cy) {
    // Pack two signed 16-bit cell coordinates into one number (no string allocation).
    return (cx + 32768) * 65536 + (cy + 32768);
}

/** Grid that is rebuilt from scratch every tick (snake bodies move every tick). */
export class RebuildGrid {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.cells = new Map();
        this.used = [];
    }

    clear() {
        for (const bucket of this.used) bucket.length = 0;
        this.used.length = 0;
    }

    insert(item, x, y) {
        const key = cellKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
        let bucket = this.cells.get(key);
        if (!bucket) {
            bucket = [];
            this.cells.set(key, bucket);
        }
        if (bucket.length === 0) this.used.push(bucket);
        bucket.push(item);
    }

    /** Calls fn(item) for items in cells overlapping the square around (x, y). Stops if fn returns true. */
    query(x, y, radius, fn) {
        const cs = this.cellSize;
        const x0 = Math.floor((x - radius) / cs);
        const x1 = Math.floor((x + radius) / cs);
        const y0 = Math.floor((y - radius) / cs);
        const y1 = Math.floor((y + radius) / cs);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const bucket = this.cells.get(cellKey(cx, cy));
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) {
                    if (fn(bucket[i])) return true;
                }
            }
        }
        return false;
    }
}

/** Grid with incremental insert/remove, for food that rarely moves. */
export class SetGrid {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.cells = new Map();
    }

    keyFor(x, y) {
        return cellKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
    }

    insert(item) {
        const key = this.keyFor(item.x, item.y);
        let bucket = this.cells.get(key);
        if (!bucket) {
            bucket = new Set();
            this.cells.set(key, bucket);
        }
        bucket.add(item);
    }

    remove(item) {
        const key = this.keyFor(item.x, item.y);
        const bucket = this.cells.get(key);
        if (bucket) {
            bucket.delete(item);
            if (bucket.size === 0) this.cells.delete(key);
        }
    }

    query(x, y, radius, fn) {
        const cs = this.cellSize;
        const x0 = Math.floor((x - radius) / cs);
        const x1 = Math.floor((x + radius) / cs);
        const y0 = Math.floor((y - radius) / cs);
        const y1 = Math.floor((y + radius) / cs);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const bucket = this.cells.get(cellKey(cx, cy));
                if (!bucket) continue;
                for (const item of bucket) {
                    if (fn(item)) return true;
                }
            }
        }
        return false;
    }
}
