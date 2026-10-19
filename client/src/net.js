/**
 * WebSocket connection with bounded, jittered reconnect.
 *
 *  - ROOM_FULL (close 4001): this world has 4 humans. Retry quickly (150-600 ms jitter) so the
 *    load balancer can route the new connection to another world/task.
 *  - Server shutdown (4002): reconnect after the delay the server suggested.
 *  - Anything else: exponential backoff with jitter, at most MAX_ATTEMPTS, then give up and
 *    show a Retry button. Never retry forever.
 */
var MAX_ATTEMPTS = 10;
var MAX_ROOM_FULL_RETRIES = 40;
var STORAGE_KEY = 'battlesnake.identity';

function GameConnection(opts) {
    this.url = opts.url;
    this.onMessage = opts.onMessage;
    this.onStatus = opts.onStatus;
    this.ws = null;
    this.stopped = true;
    this.attempt = 0;
    this.roomFullRetries = 0;
    this.suggestedRetryMs = null;
    this.retryTimer = null;
    this.joinInfo = null;
    this.lastCode = null;
}

GameConnection.prototype = {
    start: function (joinInfo) {
        this.joinInfo = joinInfo;
        this.stopped = false;
        this.attempt = 0;
        this.roomFullRetries = 0;
        this.open();
    },

    stop: function () {
        this.stopped = true;
        clearTimeout(this.retryTimer);
        if (this.ws) this.ws.close(1000, 'client left');
    },

    open: function () {
        var self = this;
        var ws;
        this.onStatus('connecting', { attempt: this.attempt, roomFullRetries: this.roomFullRetries });
        try {
            ws = new WebSocket(this.url);
        } catch (err) {
            this.scheduleReconnect({ code: 1006 });
            return;
        }
        this.ws = ws;

        ws.onopen = function () {
            var id = GameConnection.loadIdentity();
            self.onStatus('joining');
            self.send({
                t: 'join',
                name: self.joinInfo.name,
                pid: id ? id.pid : undefined,
                tok: id ? id.tok : undefined,
                vw: window.innerWidth,
                vh: window.innerHeight
            });
        };

        ws.onmessage = function (ev) {
            var msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (e) {
                return;
            }
            if (msg.t === 'welcome') {
                GameConnection.saveIdentity(msg.pid, msg.tok);
                self.attempt = 0;
                self.roomFullRetries = 0;
                self.onStatus('connected', { taskId: msg.taskId });
            } else if (msg.t === 'bye') {
                self.suggestedRetryMs = msg.retryInMs;
            }
            self.onMessage(msg);
        };

        ws.onclose = function (ev) {
            if (self.ws !== ws) return;
            self.ws = null;
            self.lastCode = ev.code;
            if (!self.stopped) self.scheduleReconnect(ev);
        };
    },

    scheduleReconnect: function (ev) {
        var delay;
        if (ev.code === 4001) {
            this.roomFullRetries++;
            if (this.roomFullRetries > MAX_ROOM_FULL_RETRIES) return this.fail('All worlds are full. Try again shortly.');
            delay = 150 + Math.random() * 450;
            this.onStatus('room_full', { retries: this.roomFullRetries });
        } else if (ev.code === 4002 || ev.code === 4003) {
            delay = this.suggestedRetryMs || 300 + Math.random() * 700;
            this.suggestedRetryMs = null;
            this.onStatus('reconnecting', { reason: 'server restarting', attempt: this.attempt });
        } else if (ev.code === 4008) {
            return this.fail('Disconnected by server (protocol violation).');
        } else {
            this.attempt++;
            if (this.attempt > MAX_ATTEMPTS) return this.fail('Could not reach the game server.');
            var base = Math.min(8000, 300 * Math.pow(2, this.attempt - 1));
            delay = base / 2 + Math.random() * (base / 2);
            this.onStatus('reconnecting', { attempt: this.attempt, max: MAX_ATTEMPTS, delayMs: Math.round(delay) });
        }
        var self = this;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(function () {
            if (!self.stopped) self.open();
        }, delay);
    },

    fail: function (reason) {
        this.stopped = true;
        this.onStatus('failed', { reason: reason });
    },

    send: function (obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    }
};

GameConnection.loadIdentity = function () {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
        return null;
    }
};

GameConnection.saveIdentity = function (pid, tok) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ pid: pid, tok: tok }));
    } catch (e) {
        /* private mode: identity lasts for this page only */
    }
};
