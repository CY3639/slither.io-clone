// Seedable PRNG so the simulation is reproducible in tests (SEED=0 means "random seed").

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function createRng(seed) {
    return mulberry32(seed || Math.floor(Math.random() * 2 ** 31));
}

/** Integer in the closed range [min, max], same contract as the original Util.randomInt. */
export function randomInt(rng, min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(rng() * (max - min + 1)) + min;
}

export function randomRange(rng, min, max) {
    return min + rng() * (max - min);
}
