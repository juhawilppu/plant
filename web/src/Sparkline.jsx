import React, { useCallback, useMemo, useState } from 'react';
import useWidth, { linePath, segmentsOf, timeScale, useTapAway } from './useWidth.js';
import { exactTime } from './when.js';

// The shape of a tile's last week, with no axes - the tile's own big number
// carries the current value. What it does carry is every reading behind the
// shape: the pointer, a finger or the arrow keys pick one out, and a readout
// says its value and exactly when it was taken, so a bump can be explained
// without going to the history page.

const HEIGHT = 46;
const PAD = { top: 6, right: 8, bottom: 6 };

// The node reports once a minute, so this much silence is an outage, and the
// line breaks there. A single late or retried reading stays well inside it.
const MAX_GAP_MS = 5 * 60 * 1000;

// `ring` is the surface the end dot sits on. It defaults to the card white, and
// the hero passes its own green: a white ring on the green hero would read as a
// deliberate halo rather than as the dot lifting off its background.
export default function Sparkline({
    points,
    color,
    label,
    unit = '',
    decimals = 1,
    ring = 'var(--surface-1)',
}) {
    const [hostRef, width] = useWidth(200, 80);
    const [cursor, setCursor] = useState(null); // index into points
    // The colour arrives as `var(--series-temp)`, which is not a legal id, so
    // the gradient is keyed on a stripped copy of it.
    const gid = `spark-${color.replace(/\W/g, '')}`;

    const withValues = useMemo(() => points.filter((p) => p.v != null), [points]);
    const lo = useMemo(() => Math.min(...withValues.map((p) => p.v)), [withValues]);
    const hi = useMemo(() => Math.max(...withValues.map((p) => p.v)), [withValues]);

    const plotW = Math.max(10, width - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    const { x, indexAt } = useMemo(() => timeScale(points, 0, plotW), [points, plotW]);
    const y = useCallback(
        (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH,
        [lo, hi, plotH],
    );

    const segments = useMemo(() => segmentsOf(points, x, y, MAX_GAP_MS), [points, x, y]);
    const lastIdx = useMemo(() => {
        for (let i = points.length - 1; i >= 0; i--) if (points[i].v != null) return i;
        return -1;
    }, [points]);

    // A new reading can shorten the list from the front (the oldest one ages
    // out of the window), which would leave the cursor past its end.
    const cur = cursor != null && cursor < points.length ? points[cursor] : null;
    const clearCursor = useCallback(() => setCursor(null), []);
    useTapAway(hostRef, cur != null, clearCursor);

    const onPointer = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setCursor(indexAt(((e.clientX - rect.left) / rect.width) * width));
    };

    const onKeyDown = (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const step = e.key === 'ArrowRight' ? 1 : -1;
            setCursor((c) =>
                Math.max(0, Math.min(points.length - 1, (c == null ? points.length : c) + step)),
            );
        } else if (e.key === 'Escape') {
            setCursor(null);
        }
    };

    const curX = cur ? x(cursor) : 0;

    // One outer element carrying the ref in every state, so the ResizeObserver
    // has something to watch before the data arrives.
    return (
        <div ref={hostRef} style={{ position: 'relative' }}>
            {!withValues.length ? null : (
                <svg
                    width="100%"
                    height={HEIGHT}
                    viewBox={`0 0 ${width} ${HEIGHT}`}
                    role="img"
                    aria-label={`${label}. Use the left and right arrow keys to read each point.`}
                    tabIndex={0}
                    onPointerDown={onPointer}
                    onPointerMove={onPointer}
                    // A finger lifting also leaves, and the readout it asked for
                    // would vanish with it; a tap elsewhere clears that one.
                    onPointerLeave={(e) => e.pointerType !== 'touch' && setCursor(null)}
                    onPointerCancel={() => setCursor(null)}
                    onKeyDown={onKeyDown}
                    onBlur={() => setCursor(null)}
                    // Vertical swipes still scroll the page; sideways ones scrub.
                    style={{ display: 'block', touchAction: 'pan-y', outline: 'none' }}
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
                            d={linePath(seg)}
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
                            stroke={ring}
                            strokeWidth="2"
                        />
                    ) : null}

                    {cur ? (
                        <>
                            <line
                                x1={curX}
                                x2={curX}
                                y1={0}
                                y2={HEIGHT}
                                stroke="var(--text-muted)"
                                strokeWidth="1"
                            />
                            {cur.v != null ? (
                                <circle
                                    cx={curX}
                                    cy={y(cur.v)}
                                    r="4"
                                    fill={color}
                                    stroke={ring}
                                    strokeWidth="2"
                                />
                            ) : null}
                        </>
                    ) : null}
                </svg>
            )}

            {/* Above the line rather than on it, so the finger that asked for it
                does not cover it. It opens away from the nearer edge. */}
            <div className="spark-readout-slot" aria-live="polite">
                {cur ? (
                    <div
                        className="chart-readout spark-readout"
                        style={
                            curX < width / 2
                                ? { left: Math.max(0, curX - 24) }
                                : { right: Math.max(0, width - curX - 24) }
                        }
                    >
                        <div className="chart-readout-value">
                            <span className="chart-readout-key" style={{ background: color }} />
                            {cur.v == null ? 'No reading' : cur.v.toFixed(decimals)}
                            {cur.v == null ? null : (
                                <span className="chart-readout-unit">{unit}</span>
                            )}
                        </div>
                        <div className="chart-readout-time">{exactTime(cur.t)}</div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
