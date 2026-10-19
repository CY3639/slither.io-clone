// Gameplay constants ported from the original Loonride client (slither-io/src/snake.js) so the
// server-side movement feels the same as the single-player game it replaces.

export const SNAKE = Object.freeze({
    startScale: 0.6, // snake.js: this.scale = 0.6
    startSections: 30, // snake.js: this.initSections(30), plus the head
    slowSpeed: 130, // px/s, snake.js: this.slowSpeed
    fastSpeed: 200, // px/s, snake.js: this.fastSpeed (boost)
    // snake.js used P2 rotateLeft(40); Phaser's P2 px->metre factor is 20, so 40 -> 2 rad/s.
    turnRate: 2.0,
    spacingFactor: 17, // snake.js: preferredDistance = 17 * scale
    baseRadius: 30, // circle.png is 60x60, so radius = 30 * scale
    edgeOffset: 4, // snake.js: the collision "edge" circle in front of the head
    growthFactor: 1.01, // snake.js: incrementSize() -> setScale(scale * 1.01)
    // New caps: unbounded growth makes snapshots unbounded in size.
    maxScale: 1.6,
    maxSections: 250,
});

export const FOOD = Object.freeze({
    radius: 8, // hex.png is 16x14
    colors: 8,
});

// Tint palette indices understood by the client (index -> colour lives in client/src/palette.js).
export const SNAKE_COLORS = 12;

export const NPC_NAMES = [
    'Viper', 'Mamba', 'Cobra', 'Python', 'Krait', 'Taipan', 'Adder', 'Boa', 'Racer', 'Garter',
    'Asp', 'Sidewinder', 'Copperhead', 'Kingsnake', 'Rattler', 'Anaconda', 'Noodle', 'Slinky',
    'Wiggles', 'Zigzag', 'Sssam', 'Hiss', 'Coil', 'Scales', 'Fang', 'Jade', 'Ember', 'Nyx',
];
