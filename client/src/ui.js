/** DOM overlay: join form, lobby countdown, HUD, leaderboards, death screen, connection status. */
var UI = (function () {
    var $ = function (id) {
        return document.getElementById(id);
    };
    var deathTimer = null;
    var lobbyTimer = null;

    function show(id, visible) {
        $(id).classList.toggle('hidden', !visible);
    }

    function renderList(el, rows, highlight) {
        el.innerHTML = '';
        rows.forEach(function (row) {
            var li = document.createElement('li');
            var name = document.createElement('span');
            name.className = 'lb-name';
            name.textContent = row.name; // textContent: names are user input, never innerHTML
            var score = document.createElement('span');
            score.className = 'lb-score';
            score.textContent = row.score;
            if (row.human) li.classList.add('human');
            if (highlight && row.name === highlight) li.classList.add('me');
            li.appendChild(name);
            li.appendChild(score);
            el.appendChild(li);
        });
        if (!rows.length) {
            var empty = document.createElement('li');
            empty.className = 'empty';
            empty.textContent = 'No scores yet';
            el.appendChild(empty);
        }
    }

    var STATUS_TEXT = {
        idle: 'Not connected',
        connecting: 'Connecting…',
        joining: 'Joining world…',
        connected: 'Connected',
        room_full: 'World full — finding another…',
        reconnecting: 'Reconnecting…',
        failed: 'Disconnected'
    };

    return {
        init: function (handlers) {
            var saved = '';
            try {
                saved = localStorage.getItem('battlesnake.name') || '';
            } catch (e) {}
            $('name-input').value = saved;
            $('join-form').addEventListener('submit', function (ev) {
                ev.preventDefault();
                var name = $('name-input').value.trim().slice(0, 16) || 'Anonymous';
                try {
                    localStorage.setItem('battlesnake.name', name);
                } catch (e) {}
                handlers.onJoin(name);
            });
            $('respawn-btn').addEventListener('click', handlers.onRespawn);
            $('retry-btn').addEventListener('click', handlers.onRetry);
            $('name-input').focus();
        },

        enterGame: function (name) {
            this.myName = name;
            show('join-panel', false);
            show('hud', true);
        },

        setStatus: function (state, info) {
            info = info || {};
            var el = $('status');
            var text = STATUS_TEXT[state] || state;
            if (state === 'reconnecting' && info.attempt) text += ' (' + info.attempt + '/' + info.max + ')';
            if (state === 'reconnecting' && info.reason) text = 'Server restarting — reconnecting…';
            if (state === 'room_full') text += ' (' + info.retries + ')';
            el.textContent = text;
            el.className = 'pill status-' + state;
            var banner = state === 'reconnecting' || state === 'room_full' || state === 'failed';
            show('conn-panel', banner);
            $('conn-text').textContent = state === 'failed' ? info.reason || text : text;
            show('retry-btn', state === 'failed');
        },

        setServerInfo: function (taskId, worldId) {
            if (taskId) this.taskId = taskId;
            if (worldId) this.worldId = worldId;
            $('server-info').textContent = 'task ' + (this.taskId || '?') + ' · world ' + (this.worldId || '–');
        },

        setPing: function (ms) {
            $('ping').textContent = Math.round(ms) + ' ms';
        },

        showLobby: function (msg) {
            show('lobby-panel', true);
            var ends = Date.now() + msg.endsIn;
            $('lobby-players').textContent = msg.humans.join(', ') + '  (' + msg.humans.length + '/' + msg.max + ' humans)';
            clearInterval(lobbyTimer);
            var tick = function () {
                $('lobby-countdown').textContent = Math.max(0, (ends - Date.now()) / 1000).toFixed(1) + ' s';
            };
            tick();
            lobbyTimer = setInterval(tick, 100);
        },

        hideLobby: function () {
            clearInterval(lobbyTimer);
            show('lobby-panel', false);
        },

        setScore: function (score) {
            $('score').textContent = score;
        },

        setWorldLeaderboard: function (lb) {
            renderList($('world-lb-list'), lb.map(function (r) {
                return { name: r[0], score: r[1], human: r[2] === 1 };
            }), this.myName);
        },

        setGlobalLeaderboard: function (items, note) {
            var rows = items.map(function (r) {
                return { name: r.displayName, score: r.bestScore, human: true };
            });
            renderList($('global-lb-list'), rows, null);
            renderList($('global-lb-mini-list'), rows.slice(0, 5), this.myName);
            $('global-lb-note').textContent = note || '';
        },

        setPersonalBest: function (best) {
            $('personal-best').textContent = best === null ? '' : 'Your best: ' + best;
        },

        showDeath: function (msg) {
            show('death-panel', true);
            $('death-score').textContent = msg.score;
            $('death-cause').textContent = msg.by ? 'Eaten by ' + msg.by : msg.cause === 'boundary' ? 'You hit the edge of the arena' : '';
            var until = Date.now() + msg.respawnIn;
            clearInterval(deathTimer);
            var tick = function () {
                $('respawn-countdown').textContent = Math.max(0, (until - Date.now()) / 1000).toFixed(1);
            };
            tick();
            deathTimer = setInterval(tick, 100);
        },

        hideDeath: function () {
            clearInterval(deathTimer);
            show('death-panel', false);
        },

        toast: function (text) {
            var el = $('toast');
            el.textContent = text;
            show('toast', true);
            clearTimeout(this.toastTimer);
            this.toastTimer = setTimeout(function () {
                show('toast', false);
            }, 3000);
        }
    };
})();
