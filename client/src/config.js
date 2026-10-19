// Runtime configuration. In AWS the page, the API and the WebSocket all share the CloudFront
// origin, so the defaults (same host) are correct and no per-environment build is needed.
// `?ws=` overrides the socket URL for testing a local client against a remote server.
window.APP_CONFIG = (function () {
    var params = new URLSearchParams(location.search);
    var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return Object.assign(
        {
            wsUrl: params.get('ws') || scheme + location.host + '/ws',
            apiBase: '',
            interpolationDelayMs: 110,
            inputHz: 20,
        },
        window.APP_CONFIG || {}
    );
})();
