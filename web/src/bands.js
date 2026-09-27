// Words for the tiles' bare numbers: "-67 dBm" means nothing to most people,
// "Fair" does. Each measure is cut into bands, and each band ships with its own
// word and icon as well as a colour, so the colour never has to carry the
// meaning alone.
//
// A value that sits on a boundary would flip the word on every reading - RSSI
// moves a few dB from one minute to the next without anything changing. So a
// band only gives way once the value is `margin` past its edge (hysteresis).
// That needs the history, not just the latest value, and the history is the
// readings already on screen: the band is replayed over them in order, so the
// answer depends only on the data, and every render and every reload of the
// same data says the same thing.

const good = { color: 'var(--status-good)', icon: 'check' };
const muted = { color: 'var(--text-muted)', icon: 'info' };
const warning = { color: 'var(--status-warning)', icon: 'alert' };
const critical = { color: 'var(--status-critical)', icon: 'alert' };

// `edges` are ascending, and there is one more level than there are edges:
// levels[i] covers edges[i - 1] <= value < edges[i].

// Rough rules of thumb for 2.4 GHz WiFi. A node publishing once a minute works
// fine on "Fair"; "Weak" is where retries and dropped connections start, and
// the offline buffer starts to earn its keep.
export const RSSI = {
    edges: [-80, -70, -60],
    margin: 3,
    levels: [
        { text: 'Poor', ...critical },
        { text: 'Weak', ...warning },
        { text: 'Fair', ...good },
        { text: 'Good', ...good },
    ],
};

// For a Monstera: happy between about 18 and 27 °C, slows down below that, and
// is damaged by long spells under 15. The sensor reads 1-2 °C high (roadmap
// 11.2), which these bands do not correct for yet.
export const AIR_TEMP = {
    edges: [15, 18, 27, 30],
    margin: 0.5,
    levels: [
        { text: 'Too cold', ...critical },
        { text: 'Cool', ...warning },
        { text: 'Comfortable', ...good },
        { text: 'Warm', ...warning },
        { text: 'Too hot', ...critical },
    ],
};

// A Monstera likes 50-60% and copes from about 40%. Much drier and the leaf
// edges brown; much wetter and the soil stays damp long enough to invite rot
// and mould. Indoor air in a heated winter often sits under 30%.
export const HUMIDITY = {
    edges: [30, 40, 70, 85],
    margin: 2,
    levels: [
        { text: 'Very dry', ...warning },
        { text: 'A bit dry', ...muted },
        { text: 'Comfortable', ...good },
        { text: 'Humid', ...good },
        { text: 'Very humid', ...warning },
    ],
};

const rawLevel = (edges, v) => edges.filter((e) => v >= e).length;

// The band of the last value in `values` (nulls skipped), with hysteresis
// applied over all of them in order. Null when there is no value at all.
export function bandOf({ edges, margin, levels }, values) {
    let level = null;
    for (const v of values) {
        if (v == null) continue;
        if (level == null) {
            level = rawLevel(edges, v);
            continue;
        }
        const raw = rawLevel(edges, v);
        // Up only once clear of the edge above the current band, down only
        // once clear of the edge below it; then to wherever the value is, less
        // the margin, which may be more than one band away.
        if (raw > level && v - margin >= edges[level]) level = rawLevel(edges, v - margin);
        else if (raw < level && v + margin < edges[level - 1])
            level = rawLevel(edges, v + margin);
    }
    return level == null ? null : levels[level];
}
