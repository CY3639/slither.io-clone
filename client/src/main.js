/** Bootstrap: wires the network connection, the Phaser scene and the DOM UI together. */
(function () {
    var scene = null;
    var pendingBeforeScene = [];
    var pingTimer = null;

    var conn = new GameConnection({
        url: APP_CONFIG.wsUrl,
        onMessage: onMessage,
        onStatus: function (state, info) {
            UI.setStatus(state, info);
            if (state === 'connected' && info) UI.setServerInfo(info.taskId, null);
        }
    });

    window.GameBridge = {
        sceneReady: function (s) {
            scene = s;
            pendingBeforeScene.forEach(onMessage);
            pendingBeforeScene = [];
        },
        send: function (msg) {
            conn.send(msg);
        }
    };

    function onMessage(msg) {
        if (!scene && (msg.t === 'start' || msg.t === 'food' || msg.t === 's')) {
            pendingBeforeScene.push(msg);
            return;
        }
        switch (msg.t) {
            case 'welcome':
                UI.setServerInfo(msg.taskId, null);
                break;
            case 'lobby':
                UI.showLobby(msg);
                break;
            case 'start':
                UI.hideLobby();
                UI.hideDeath();
                UI.setServerInfo(null, msg.worldId);
                scene.onStart(msg);
                break;
            case 'food':
                scene.onFood(msg);
                break;
            case 's':
                scene.onSnapshot(msg);
                UI.setScore(msg.sc);
                if (msg.lb) UI.setWorldLeaderboard(msg.lb);
                break;
            case 'spawn':
                UI.hideDeath();
                break;
            case 'dead':
                UI.showDeath(msg);
                setTimeout(refreshLeaderboard, 2500); // give SQS → Lambda → DynamoDB a moment
                break;
            case 'pong':
                UI.setPing(Date.now() - msg.c);
                break;
            case 'bye':
                UI.toast('Server is restarting — moving you to another world');
                break;
            case 'err':
                if (msg.code !== 'ROOM_FULL') UI.toast('Server: ' + msg.code);
                break;
        }
    }

    function refreshLeaderboard() {
        fetch(APP_CONFIG.apiBase + '/api/leaderboard?limit=10')
            .then(function (res) {
                if (!res.ok) throw new Error(res.status);
                return res.json();
            })
            .then(function (body) {
                UI.setGlobalLeaderboard(body.items || []);
            })
            .catch(function () {
                UI.setGlobalLeaderboard([], 'Leaderboard unavailable');
            });

        var id = GameConnection.loadIdentity();
        if (!id) return UI.setPersonalBest(null);
        fetch(APP_CONFIG.apiBase + '/api/player?id=' + encodeURIComponent(id.pid))
            .then(function (res) {
                return res.ok ? res.json() : null;
            })
            .then(function (body) {
                UI.setPersonalBest(body && body.player ? body.player.bestScore : null);
            })
            .catch(function () {});
    }

    UI.init({
        onJoin: function (name) {
            UI.enterGame(name);
            conn.start({ name: name });
            clearInterval(pingTimer);
            pingTimer = setInterval(function () {
                conn.send({ t: 'ping', c: Date.now() });
            }, 2000);
        },
        onRespawn: function () {
            conn.send({ t: 'respawn' });
        },
        onRetry: function () {
            conn.start(conn.joinInfo);
        }
    });
    UI.setStatus('idle');
    refreshLeaderboard();
    setInterval(refreshLeaderboard, 20000);

    var game = new Phaser.Game('100%', '100%', Phaser.AUTO, 'game', null, false, true);
    game.state.add('Play', PlayState);
    game.state.start('Play');
})();
