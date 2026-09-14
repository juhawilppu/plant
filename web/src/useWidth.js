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

// A dropped sensor leaves a null, and a line must break there rather than
// drawing a straight lie across the gap. Shared by both chart components.
export function segmentsOf(points, x, y) {
    const out = [];
    let run = [];
    points.forEach((p, i) => {
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
