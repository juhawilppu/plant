// The dashboard's logo: a Monstera leaf. The header's mark, the favicon and
// the home-screen icons are all drawn from this one path - the icons by
// scripts/icons.mjs - so they cannot drift apart.
//
// The leaf is "Monstera leaf" by Delapouite (https://delapouite.com), from
// game-icons.net, under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/):
// free to use and change, as long as Delapouite is credited. The README
// credits it, and so does the mark's tooltip, from MONSTERA_CREDIT below. Two
// attempts at drawing one here did not look like a Monstera; this does.
export const MONSTERA_CREDIT = 'Monstera leaf by Delapouite (game-icons.net), CC BY 3.0';

// In a 512-unit box, centred on 256 256. One outline: the slits are part of
// its edge, not holes painted over it, so it sits on any background.
const LEAF =
    'M332.9 17.37c-11.7-.1-24.2 1.23-37.5 4.13c-33.1 7.21-48.6 28.49-56.2 54.09' +
    'c11.2 22.86 20.1 46.01 25 71.91c-9.6-6.9-19.7-1.7-22.6 5' +
    'c-4.3-22.4-10-42.9-17.8-62.93c-48.8-34.88-83-20.9-89.6-18.76' +
    'C49.64 98.12 25.54 165.7 39.84 239.1c19.32-43.4 86.56-68.7 113.56-68.6' +
    'c6.9.1 47 9.5 13.6 20c-54.8 17.3-98.29 48.7-116.81 86' +
    'c8.78 24.5 21.34 49.1 36.89 72.4c14.42-42 40.22-89 96.72-125.1' +
    'c14.5-9.3 23.8.7 12.2 13.2c-53.5 57.4-75.1 104.2-81 148.6' +
    'c17.4 20.3 37.2 38.9 58.5 54.7c1.6-54.4 20.3-117.7 56.3-164.6' +
    'c3.7-6.6 22-2.7 15.6 9c-27.9 50.9-43.2 119.9-44.5 174' +
    'c25.6 15.2 52.9 26.3 80.9 31.9c-15.1-35.2-18.5-80.5-6.9-120.8' +
    'c5.1-17.8 20.8-8.1 17.6 4.2c-10 38.8 8.6 87.5 28.1 120.6' +
    'c20.7.1 41.6-3.1 62.3-10.2c11.8-4 22.7-12.3 32.7-23.8' +
    'c-11.3-22.8-27-44.1-46.6-57.2c-7.4-5-3.2-23.6 10.2-14.8' +
    'c19.1 12.6 37.6 29.7 52.8 48.7c9.8-16.8 18.2-37 25-59.4' +
    'c-29.7-34.7-83.3-82-128.8-101.7c-9.6-4.1-8.7-21.5 7.6-16.4' +
    'c47.8 14.8 98 46.2 131.1 78c3.9-19.9 6.7-40.8 8.1-61.9' +
    'c-39-27.6-95.5-67.2-147.1-74.8c-9.5-1.4-13.6-18.6 3-17.8' +
    'c58.3 2.7 109.8 23.5 145.1 50.5c-.5-28.6-3.6-56.7-9.7-82.9' +
    'c-41.7-13.6-113.5-18.5-141.5-6.1c-11.1 4.9-29.9-4.8-6.8-16.6' +
    'c37.6-22.1 94.5-22.8 138.3-11c-21.3-57.97-60.7-99.32-123.4-99.83';

// The leaf as SVG markup for a 64-unit square: centred, `scale` of the
// square across.
export function monsteraLeaf({ fill, scale }) {
    const s = ((64 / 512) * scale).toFixed(4);
    return `<path transform="translate(32 32) scale(${s}) translate(-256 -256)" fill="${fill}" d="${LEAF}"/>`;
}
