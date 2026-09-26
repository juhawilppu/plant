import { useEffect, useRef, useState } from 'react';

// Both the charts and the tile sparklines size themselves to their card rather
// than stretching a fixed viewBox, so the mark specs - stroke widths, dot
// radii, type sizes - stay in real pixels at every column width.
export default function useWidth(initial, min) {
    const ref = useRef(null);
    const [width, setWidth] = useState(initial);

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect?.width;
            if (w) setWidth(Math.max(min, w));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [min]);

    return [ref, width];
}

// Points sit across the plot by their time, not by their place in the list, so
// an outage keeps its real width instead of closing up as if it never happened.
// `x(i)` places point i; `indexAt(px)` is the point nearest a pixel column, for
// the crosshair.
export function timeScale(points, left, width) {
    const ms = points.map((p) => Date.parse(p.t));
    const t0 = ms[0];
    const span = ms.length > 1 ? ms[ms.length - 1] - t0 : 0;
    const x = (i) => left + (span > 0 ? ((ms[i] - t0) / span) * width : width / 2);
    const indexAt = (px) => {
        if (!ms.length) return null;
        const t = t0 + ((px - left) / width) * span;
        let lo = 0;
        let hi = ms.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ms[mid] < t) lo = mid + 1;
            else hi = mid;
        }
        return lo > 0 && t - ms[lo - 1] < ms[lo] - t ? lo - 1 : lo;
    };
    return { x, indexAt };
}

// True when point i starts a new run: more than `maxGapMs` passed since the
// point before it, so readings are missing in between.
export function gapBefore(points, i, maxGapMs) {
    return i > 0 && Date.parse(points[i].t) - Date.parse(points[i - 1].t) > maxGapMs;
}

// A dropped sensor leaves a null, and an outage leaves no rows at all. The line
// breaks at both rather than drawing a straight lie across the gap. Shared by
// both chart components.
export function segmentsOf(points, x, y, maxGapMs = Infinity) {
    const out = [];
    let run = [];
    points.forEach((p, i) => {
        if (run.length && gapBefore(points, i, maxGapMs)) {
            out.push(run);
            run = [];
        }
        if (p.v == null) {
            if (run.length) out.push(run);
            run = [];
        } else {
            run.push([x(i), y(p.v)]);
        }
    });
    if (run.length) out.push(run);
    return out;
}

// A run's line. A lone reading between two gaps is a zero-length line, which
// the round cap draws as a dot, so it still shows instead of vanishing.
export function linePath(seg) {
    if (seg.length === 1) return `M ${seg[0][0]} ${seg[0][1]} l 0 0`;
    return seg.map(([px, py], j) => `${j ? 'L' : 'M'} ${px} ${py}`).join(' ');
}
