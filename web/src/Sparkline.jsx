import React, { useCallback, useMemo } from 'react';
import useWidth, { segmentsOf } from './useWidth.js';

// The shape of a tile's last 24 hours, with no axes and no readable values -
// the tile's own big number carries the value. Purely a trend cue, so it is
// aria-hidden: every number it hints at is already in the tile above it and in
// the table view.

const HEIGHT = 46;
const PAD = { top: 6, right: 8, bottom: 6 };

export default function Sparkline({ points, color }) {
    const [hostRef, width] = useWidth(200, 80);
    // The colour arrives as `var(--series-temp)`, which is not a legal id, so
    // the gradient is keyed on a stripped copy of it.
    const gid = `spark-${color.replace(/\W/g, '')}`;

    const withValues = useMemo(() => points.filter((p) => p.v != null), [points]);
    const lo = useMemo(() => Math.min(...withValues.map((p) => p.v)), [withValues]);
    const hi = useMemo(() => Math.max(...withValues.map((p) => p.v)), [withValues]);

    const plotW = Math.max(10, width - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    const x = useCallback(
        (i) => (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW),
        [points.length, plotW],
    );
    const y = useCallback(
        (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH,
        [lo, hi, plotH],
    );

    const segments = useMemo(() => segmentsOf(points, x, y), [points, x, y]);
    const lastIdx = useMemo(() => {
        for (let i = points.length - 1; i >= 0; i--) if (points[i].v != null) return i;
        return -1;
    }, [points]);

    // One outer element carrying the ref in every state, so the ResizeObserver
    // has something to watch before the data arrives.
    return (
        <div ref={hostRef}>
            {!withValues.length ? null : (
                <svg
                    width="100%"
                    height={HEIGHT}
                    viewBox={`0 0 ${width} ${HEIGHT}`}
                    aria-hidden="true"
                    focusable="false"
                    style={{ display: 'block' }}
                >
                    <defs>
                        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
                            <stop offset="100%" stopColor={color} stopOpacity="0" />
                        </linearGradient>
                    </defs>

                    {segments.map((seg, i) => (
                        <path
                            key={`a${i}`}
                            d={
                                `M ${seg[0][0]} ${PAD.top + plotH} ` +
                                seg.map(([px, py]) => `L ${px} ${py}`).join(' ') +
                                ` L ${seg[seg.length - 1][0]} ${PAD.top + plotH} Z`
                            }
                            fill={`url(#${gid})`}
                        />
                    ))}

                    {segments.map((seg, i) => (
                        <path
                            key={`l${i}`}
                            d={seg.map(([px, py], j) => `${j ? 'L' : 'M'} ${px} ${py}`).join(' ')}
                            fill="none"
                            stroke={color}
                            strokeWidth="2.4"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                        />
                    ))}

                    {lastIdx >= 0 ? (
                        <circle
                            cx={x(lastIdx)}
                            cy={y(points[lastIdx].v)}
                            r="4"
                            fill={color}
                            stroke="var(--surface-1)"
                            strokeWidth="2"
                        />
                    ) : null}
                </svg>
            )}
        </div>
    );
}
