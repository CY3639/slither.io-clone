// Tint palettes. The server sends colour indices; indices 0, 3, 6, 9 are reserved for humans.
var PALETTE = {
    snake: [
        0xff4d4d, 0xffa64d, 0xffe14d, 0x4dff88, 0x4dd2ff, 0x4d79ff,
        0xb84dff, 0xff4dd2, 0x9cff4d, 0x4dffd2, 0xff7a4d, 0xd2a6ff
    ],
    food: [0xff3b3b, 0xffb03b, 0xfff23b, 0x5bff3b, 0x3bffe6, 0x3b8bff, 0xc23bff, 0xff3bb4],
    // From the original shadow.js.
    shadowDark: 0xaaaaaa,
    shadowBright: 0xaa3333,
    shadowDim: 0xdd3333,
    boundary: 0xff3333
};

function cssColor(hex) {
    return '#' + ('000000' + hex.toString(16)).slice(-6);
}
