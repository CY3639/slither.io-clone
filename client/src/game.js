/**
 * Phaser 2 state. Compared with the original game.js, this state no longer simulates anything:
 * it turns input into intent messages, buffers server snapshots, and renders the interpolated
 * world with the original assets.
 */
function PlayState() {}

PlayState.prototype = {
    init: function () {
        this.game.scale.scaleMode = Phaser.ScaleManager.RESIZE;
        this.game.stage.disableVisibilityChange = true; // keep rendering/sending while tab is hidden
    },

    preload: function () {
        var urls = window.ASSET_URLS || {};
        var load = this.game.load;
        // Same asset keys as the original game.js preload().
        load.image('circle', urls['circle.png'] || 'asset/circle.png');
        load.image('shadow', urls['white-shadow.png'] || 'asset/white-shadow.png');
        load.image('background', urls['tile.png'] || 'asset/tile.png');
        load.image('eye-white', urls['eye-white.png'] || 'asset/eye-white.png');
        load.image('eye-black', urls['eye-black.png'] || 'asset/eye-black.png');
        load.image('food', urls['hex.png'] || 'asset/hex.png');
    },

    create: function () {
        this.game.stage.backgroundColor = '#444';
        this.textures = { circle: this.makeWhiteCircle() };
        this.bgLayer = this.game.add.group();
        this.foodLayer = this.game.add.group();
        this.snakeLayer = this.game.add.group();
        this.food = new FoodField(this.game, this.foodLayer);
        this.views = {};
        this.buffer = new SnapshotBuffer(APP_CONFIG.interpolationDelayMs);
        this.myId = null;
        this.camX = 0;
        this.camY = 0;
        this.setupWorld(2400);

        this.cursors = this.game.input.keyboard.createCursorKeys();
        this.spaceKey = this.game.input.keyboard.addKey(Phaser.Keyboard.SPACEBAR);
        this.intent = { angle: 0, boost: false, sentAngle: null, sentBoost: null, lastSent: 0, useMouse: true, lastPointer: null };
        if (window.GameBridge) window.GameBridge.sceneReady(this);
    },

    /** circle.png is solid red, so tinting could only give reds. Desaturate it once into a white
     *  texture (keeping the original outline shading) so each snake can be tinted any colour. */
    makeWhiteCircle: function () {
        var img = this.game.cache.getImage('circle');
        var bmd = this.game.make.bitmapData(img.width, img.height);
        bmd.draw(img, 0, 0);
        bmd.update();
        bmd.processPixelRGB(function (p) {
            var v = Math.max(p.r, p.g, p.b);
            p.r = v;
            p.g = v;
            p.b = v;
            return p;
        });
        return bmd;
    },

    setupWorld: function (radius) {
        this.radius = radius;
        var pad = 700;
        this.game.world.setBounds(-radius - pad, -radius - pad, (radius + pad) * 2, (radius + pad) * 2);
        this.bgLayer.removeAll(true);
        this.game.add.tileSprite(-radius - pad, -radius - pad, (radius + pad) * 2, (radius + pad) * 2, 'background', null, this.bgLayer);
        var border = this.game.add.graphics(0, 0, this.bgLayer);
        border.lineStyle(24, PALETTE.boundary, 0.55);
        border.drawCircle(0, 0, radius * 2);
    },

    // ------------------------------------------------------------------ messages (from main.js)

    onStart: function (msg) {
        this.setupWorld(msg.radius);
        this.buffer.reset();
        this.clearViews();
        this.myId = null;
    },

    onFood: function (msg) {
        this.food.reset(msg.f);
    },

    onSnapshot: function (msg) {
        this.buffer.push(msg);
    },

    clearViews: function () {
        for (var id in this.views) this.views[id].destroy();
        this.views = {};
    },

    // ------------------------------------------------------------------ frame

    update: function () {
        var dt = this.game.time.physicsElapsed || 1 / 60;
        var renderTs = this.buffer.renderTime();

        // Apply food deltas when the render clock reaches their snapshot, so pellets vanish as the
        // (interpolated) head actually reaches them rather than ~110 ms early.
        var due = this.buffer.takeDue(renderTs);
        for (var i = 0; i < due.length; i++) {
            this.food.add(due[i].fa);
            this.food.remove(due[i].fr);
        }

        var frame = this.buffer.sample(renderTs);
        if (frame) {
            this.myId = frame.me;
            this.syncViews(frame);
            var me = frame.me !== null ? this.views[frame.me] : null;
            var focus = me ? me.head() : frame.focus;
            if (focus) this.moveCamera(focus, dt);
        }
        this.handleInput(dt);
        this.food.animate(this.game.time.now);
    },

    syncViews: function (frame) {
        var seen = {};
        var pointerAngle = this.pointerAngle();
        for (var i = 0; i < frame.snakes.length; i++) {
            var s = frame.snakes[i];
            seen[s.id] = true;
            var view = this.views[s.id];
            if (!view) view = this.views[s.id] = new SnakeView(this.game, this.snakeLayer, this.textures, s.id, s.id === frame.me);
            view.update(s, s.id === frame.me ? pointerAngle : null);
        }
        for (var id in this.views) {
            if (!seen[id]) {
                this.views[id].destroy();
                delete this.views[id];
            }
        }
        // Own snake drawn above everyone else.
        if (frame.me !== null && this.views[frame.me]) this.snakeLayer.bringToTop(this.views[frame.me].group);
    },

    moveCamera: function (focus, dt) {
        var k = Math.min(1, dt * 12);
        this.camX += (focus.x - this.camX) * k;
        this.camY += (focus.y - this.camY) * k;
        if (Math.abs(focus.x - this.camX) > 600 || Math.abs(focus.y - this.camY) > 600) {
            this.camX = focus.x; // teleport on respawn instead of a long pan
            this.camY = focus.y;
        }
        this.game.camera.focusOnXY(this.camX, this.camY);
    },

    pointerAngle: function () {
        var view = this.myId !== null ? this.views[this.myId] : null;
        var head = view && view.head();
        if (!head) return null;
        var p = this.game.input.activePointer;
        return Math.atan2(p.y - (head.y - this.game.camera.y), p.x - (head.x - this.game.camera.x));
    },

    /** Turn mouse/keyboard into intent; send at most APP_CONFIG.inputHz, only when it changes. */
    handleInput: function (dt) {
        if (this.myId === null || !window.GameBridge) return;
        var inp = this.intent;
        var p = this.game.input.activePointer;
        var moved = !inp.lastPointer || inp.lastPointer.x !== p.x || inp.lastPointer.y !== p.y;
        inp.lastPointer = { x: p.x, y: p.y };

        if (this.cursors.left.isDown) {
            inp.angle -= 2.5 * dt;
            inp.useMouse = false;
        } else if (this.cursors.right.isDown) {
            inp.angle += 2.5 * dt;
            inp.useMouse = false;
        } else if (moved) {
            inp.useMouse = true;
        }
        if (inp.useMouse) {
            var a = this.pointerAngle();
            if (a !== null) inp.angle = a;
        }
        inp.boost = this.spaceKey.isDown || p.isDown;

        var now = this.game.time.now;
        var changed = inp.sentAngle === null || Math.abs(inp.angle - inp.sentAngle) > 0.02 || inp.boost !== inp.sentBoost;
        var interval = 1000 / APP_CONFIG.inputHz;
        if ((changed && now - inp.lastSent >= interval) || now - inp.lastSent > 1000) {
            window.GameBridge.send({ t: 'in', a: Math.round(inp.angle * 1000) / 1000, b: inp.boost ? 1 : 0 });
            inp.sentAngle = inp.angle;
            inp.sentBoost = inp.boost;
            inp.lastSent = now;
        }
    }
};
