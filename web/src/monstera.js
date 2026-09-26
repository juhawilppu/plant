// The dashboard's logo: a Monstera leaf. The header's mark, the favicon and
// the home-screen icons are all drawn from this one definition - the icons by
// scripts/icons.mjs - so they cannot drift apart.
//
// Drawn upright around the origin: the tip at y -32, the notch where the stalk
// joins at y 13, and the two lobes of the heart hanging below it to y 22.
//
// What makes it read as a Monstera, learnt from a first version that did not:
// the veins sweep from the midrib toward the tip like a feather's, rather than
// fanning out from the centre, which drew a sliced pie. Between each pair of
// veins runs a channel, and along each channel the real leaf is cut from the
// edge, with a rounded end, and holed nearer the midrib, the two parted by a
// bridge of leaf. The holes are what make it the "Swiss cheese plant". The tip
// and the lobes stay whole.
const OUTLINE =
    'M0 -32C2.5 -27 9 -25.5 14 -22.5C21.5 -17.5 26 -9 26 0C26 12 17.5 22 8.5 22' +
    'C4.5 22 1.5 17.5 0 13C-1.5 17.5 -4.5 22 -8.5 22C-17.5 22 -26 12 -26 0' +
    'C-26 -9 -21.5 -17.5 -14 -22.5C-9 -25.5 -2.5 -27 0 -32Z';

// The right side's channels, each a quadratic curve from beside the midrib out
// past the edge; the left side mirrors them. The top one leaves by the
// shoulder, not beside the tip, so the tip stays a point.
const CHANNELS = [
    [[3, -14], [13, -17.5], [26, -25]],
    [[3, -4], [16, -6], [31, -15]],
    [[3, 6], [17, 6], [32, 1]],
];

// Where along a channel (0 at the midrib, 1 past the edge) the hole and the
// cut sit, and how wide each is either side of the channel, in leaf units.
const HOLE = { from: 0.07, to: 0.25, width: 1.35 };
const CUT = { from: 0.32, inner: 2.1, outer: 3.6 };

const MIDRIB = 'M0 12Q.6 -8 0 -25';
const STALK = 'M0 13Q-.5 24 -5.5 30';

const at = ([a, b, c], t) =>
    [0, 1].map((i) => (1 - t) ** 2 * a[i] + 2 * (1 - t) * t * b[i] + t * t * c[i]);
const along = ([a, b, c], t) =>
    [0, 1].map((i) => 2 * (1 - t) * (b[i] - a[i]) + 2 * t * (c[i] - b[i]));
const pt = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;

// A shape following a stretch of channel, width(u) either side of it for u
// from 0 to 1 along the stretch. A cut starts with a round end; a hole is a
// lens, closed at both ends by its own width falling to nothing.
function strip(curve, from, to, width, roundStart) {
    const steps = 14;
    const left = [];
    const right = [];
    for (let k = 0; k <= steps; k++) {
        const t = from + ((to - from) * k) / steps;
        const [x, y] = at(curve, t);
        const [dx, dy] = along(curve, t);
        const len = Math.hypot(dx, dy);
        const w = width(k / steps);
        left.push([x - (dy / len) * w, y + (dx / len) * w]);
        right.push([x + (dy / len) * w, y - (dx / len) * w]);
    }
    const r = width(0);
    const start = roundStart ? `M${pt(right[0])}A${r} ${r} 0 0 1 ${pt(left[0])}` : `M${pt(left[0])}`;
    const edge = (points) => points.map((p) => `L${pt(p)}`).join('');
    return `${start}${edge(left.slice(1))}${edge(right.reverse())}Z`;
}

const OPENINGS = [1, -1].flatMap((side) =>
    CHANNELS.map((c) => c.map(([x, y]) => [x * side, y])).flatMap((curve) => [
        strip(curve, HOLE.from, HOLE.to, (u) => HOLE.width * Math.sin(Math.PI * u) ** 0.8, false),
        strip(curve, CUT.from, 1, (u) => CUT.inner + (CUT.outer - CUT.inner) * u, true),
    ]),
);

// The leaf as SVG markup for a 64-unit square: centred, the tip leaning to
// the upper right, `scale` of its full size. The cuts, holes and midrib are
// painted in `cut`, the colour of whatever the leaf sits on, which is what
// makes them openings.
export function monsteraLeaf({ fill, cut, scale }) {
    const openings = OPENINGS.map((d) => `<path d="${d}" fill="${cut}"/>`).join('');
    return (
        `<g transform="translate(32.5 31.5) rotate(30) scale(${scale})">` +
        `<path d="${STALK}" stroke="${fill}" stroke-width="3.4" stroke-linecap="round" fill="none"/>` +
        `<path d="${OUTLINE}" fill="${fill}"/>${openings}` +
        `<path d="${MIDRIB}" stroke="${cut}" stroke-width="1.2" stroke-linecap="round" fill="none"/>` +
        `</g>`
    );
}
