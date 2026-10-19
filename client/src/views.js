/**
 * Rendering-only snake. Positions come from the server; this class draws them with the original
 * sprites: tinted circle sections (snake.js), the light-up shadow (shadow.js) and the eye pair
 * (eye.js / eyePair.js). The original P2 lock/distance constraints are replaced by direct maths.
 */
function SnakeView(game, parent, textures, id, isMe) {
    this.game = game;
    this.id = id;
    this.isMe = isMe;
    this.textures = textures;
    this.group = game.add.group(parent);
    this.shadowGroup = game.add.group(this.group);
    this.bodyGroup = game.add.group(this.group);
    this.eyeGroup = game.add.group(this.group);
    this.sections = [];
    this.shadows = [];
    this.color = null;

    // Shadow light-up animation state (shadow.js).
    this.lightStep = 0;
    this.lightCount = 0;

    this.eyes = [];
    for (var i = 0; i < 2; i++) {
        var white = game.add.sprite(0, 0, 'eye-white', null, this.eyeGroup);
        var black = game.add.sprite(0, 0, 'eye-black', null, this.eyeGroup);
        white.anchor.set(0.5);
        black.anchor.set(0.5);
        this.eyes.push({ white: white, black: black });
    }

    this.label = null;
    if (!isMe) {
        this.label = game.add.text(0, 0, '', {
            font: '13px Arial', fill: '#ffffff', stroke: '#000000', strokeThickness: 3
        }, this.group);
        this.label.anchor.set(0.5, 1);
    }
}

SnakeView.prototype = {
    /** s = { pts: [x0,y0,x1,y1,...], scale, boost, color, name }, look = angle pupils face. */
    update: function (s, look) {
        var n = s.pts.length / 2;
        this.resize(n);
        var tint = PALETTE.snake[s.color % PALETTE.snake.length];
        var tintChanged = tint !== this.color;
        this.color = tint;

        for (var i = 0; i < n; i++) {
            var sec = this.sections[i];
            var sh = this.shadows[i];
            sec.x = sh.x = s.pts[i * 2];
            sec.y = sh.y = s.pts[i * 2 + 1];
            sec.scale.set(s.scale);
            sh.scale.set(s.scale);
            if (tintChanged || sec.tint !== tint) sec.tint = tint;
        }
        this.updateShadow(s.boost, n);
        this.updateEyes(s, look);

        if (this.label) {
            this.label.text = s.name;
            this.label.x = s.pts[0];
            this.label.y = s.pts[1] - 30 * s.scale - 8;
        }
    },

    resize: function (n) {
        while (this.sections.length < n) {
            // New sections go to the back of the group (snake.js: sec.sendToBack()) so the head is on top.
            var sec = this.game.make.sprite(0, 0, this.textures.circle);
            sec.anchor.set(0.5);
            this.bodyGroup.addAt(sec, 0);
            this.sections.push(sec);
            var sh = this.game.make.sprite(0, 0, 'shadow');
            sh.anchor.set(0.5);
            this.shadowGroup.addAt(sh, 0);
            this.shadows.push(sh);
        }
        while (this.sections.length > n) {
            this.sections.pop().destroy();
            this.shadows.pop().destroy();
        }
    },

    /** shadow.js: dark grey normally; alternating bright/dim red bands while boosting. */
    updateShadow: function (boost, n) {
        var i;
        if (!boost) {
            for (i = 0; i < n; i++) this.shadows[i].tint = PALETTE.shadowDark;
            return;
        }
        if (++this.lightCount < 3) return;
        this.lightCount = 0;
        for (i = 0; i < n; i++) {
            this.shadows[i].tint = (i - this.lightStep) % 3 === 0 ? PALETTE.shadowBright : PALETTE.shadowDim;
        }
        this.lightStep = (this.lightStep + 1) % 3;
    },

    /** eyePair.js offsets: x = head width * 0.25 sideways, y = head width * 0.125 forward. */
    updateEyes: function (s, look) {
        var hx = s.pts[0];
        var hy = s.pts[1];
        var heading = s.pts.length >= 4 ? Math.atan2(hy - s.pts[3], hx - s.pts[2]) : 0;
        var headWidth = 60 * s.scale;
        var side = headWidth * 0.25;
        var fwd = headWidth * 0.125;
        var fx = Math.cos(heading);
        var fy = Math.sin(heading);
        var lookAngle = look === null ? heading : look;
        for (var i = 0; i < 2; i++) {
            var sign = i === 0 ? -1 : 1;
            var ex = hx + fx * fwd - fy * side * sign;
            var ey = hy + fy * fwd + fx * side * sign;
            var eye = this.eyes[i];
            eye.white.x = ex;
            eye.white.y = ey;
            eye.white.scale.set(s.scale);
            // eye.js: the pupil sits a quarter of the white's width toward where the snake looks.
            var pupil = 28 * s.scale * 0.25;
            eye.black.x = ex + Math.cos(lookAngle) * pupil;
            eye.black.y = ey + Math.sin(lookAngle) * pupil;
            eye.black.scale.set(s.scale);
        }
    },

    head: function () {
        return this.sections.length ? { x: this.sections[0].x, y: this.sections[0].y } : null;
    },

    destroy: function () {
        this.group.destroy(true);
    }
};

/** All food pellets (hex.png tinted), keyed by server food id. */
function FoodField(game, parent) {
    this.game = game;
    this.group = game.add.group(parent);
    this.sprites = {};
    this.count = 0;
}

FoodField.prototype = {
    reset: function (flat) {
        this.group.removeAll(true);
        this.sprites = {};
        this.count = 0;
        this.add(flat);
    },

    /** flat = [id, x, y, colour, id, x, y, colour, ...] */
    add: function (flat) {
        for (var i = 0; i < flat.length; i += 4) {
            var id = flat[i];
            if (this.sprites[id]) continue;
            var f = this.game.add.sprite(flat[i + 1], flat[i + 2], 'food', null, this.group);
            f.anchor.set(0.5);
            f.tint = PALETTE.food[flat[i + 3] % PALETTE.food.length];
            f.phase = (id % 17) / 17 * Math.PI * 2;
            this.sprites[id] = f;
            this.count++;
        }
    },

    remove: function (ids) {
        for (var i = 0; i < ids.length; i++) {
            var f = this.sprites[ids[i]];
            if (!f) continue;
            f.destroy();
            delete this.sprites[ids[i]];
            this.count--;
        }
    },

    /** Gentle pulse so food reads as "alive" (cheap: only alpha). */
    animate: function (time) {
        var children = this.group.children;
        for (var i = 0; i < children.length; i++) {
            var f = children[i];
            f.alpha = 0.75 + 0.25 * Math.sin(time / 300 + f.phase);
        }
    }
};
