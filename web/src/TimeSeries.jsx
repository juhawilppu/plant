import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// One measure over time, hand-rolled in SVG rather than pulled from a chart
// library: the mark specs here (2px line, >=8px end dot with a 2px surface ring,
// hairline solid gridlines, 10% area wash, a single direct end-label) are easier
// to hold exactly than to argue a library into.
//
// Always a SINGLE series, so there is no legend - the card's title names what is
// plotted, and a one-swatch legend would only restate it. Two measures never
// share these axes: a second y-scale is the one thing this file will not do.

const PAD = { top: 16, right: 60, bottom: 26, left: 46 };
const HEIGHT = 190;

// Rounded, human tick values - the ticks carry every number that isn't directly
// labelled, so they have to read cleanly.
function niceScale(min, max, count = 4) {
    if (!isFinite(min) || !isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
    if (min === max) {
        const pad = Math.abs(min) > 1 ? Math.abs(min) * 0.1 : 1;
        min -= pad;
        max += pad;
    }
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo, hi, ticks };
}

function formatTime(iso, spanHours) {
    const d = new Date(iso);
    if (spanHours <= 48) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export default function TimeSeries({
    title,
    unit,
    color,
    points, // [{ t: ISO string, v: number | null }]
    spanHours,
    decimals = 1,
    className = '',
}) {
    const hostRef = useRef(null);
    const [width, setWidth] = useState(640);
    const [cursor, setCursor] = useState(null); // index into points

    useEffect(() => {
        const el = hostRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect?.width;
            if (w) setWidth(Math.max(260, w));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const withValues = useMemo(() => points.filter((p) => p.v != null), [points]);

    const { lo, hi, ticks } = useMemo(() => {
        const vals = withValues.map((p) => p.v);
        return niceScale(Math.min(...vals), Math.max(...vals));
    }, [withValues]);

    const plotW = Math.max(10, width - PAD.left - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    const x = useCallback(
        (i) => PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW),
        [points.length, plotW],
    );
    const y = useCallback(
        (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH,
        [lo, hi, plotH],
    );

    // A dropped sensor leaves a null, and the line breaks there rather than
    // drawing a straight lie across the gap.
    const segments = useMemo(() => {
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
    }, [points, x, y]);

    const lastIdx = useMemo(() => {
        for (let i = points.length - 1; i >= 0; i--) if (points[i].v != null) return i;
        return -1;
    }, [points]);

    const fmt = (v) => (v == null ? '—' : v.toFixed(decimals));

    const onPointer = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * width;
        // The crosshair snaps to the nearest data position, so the reader aims
        // at a time rather than at a 2px line.
        const ratio = (px - PAD.left) / plotW;
        const idx = Math.round(ratio * (points.length - 1));
        setCursor(Math.max(0, Math.min(points.length - 1, idx)));
    };

    const onKeyDown = (e) => {
        if (!points.length) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const step = e.key === 'ArrowRight' ? 1 : -1;
            setCursor((c) => {
                const next = (c == null ? points.length - 1 : c) + step;
                return Math.max(0, Math.min(points.length - 1, next));
            });
        } else if (e.key === 'Escape') {
            setCursor(null);
        }
    };

    const cur = cursor != null ? points[cursor] : null;
    const curX = cursor != null ? x(cursor) : 0;

    // One outer element carrying the ref in every state. The empty case used to
    // return early from its own div, which meant the ResizeObserver effect ran
    // against a null ref on the first paint and never re-ran once data arrived.
    return (
        <div className={`card ${className}`} ref={hostRef} style={{ position: 'relative' }}>
            <div className="tile-label">
                <span className="key" style={{ background: color }} />
                {title}
                {unit ? <span style={{ color: 'var(--text-muted)' }}>({unit})</span> : null}
            </div>

            {!withValues.length ? (
                <div className="empty">No readings in this range</div>
            ) : (
            <>

            <svg
                width="100%"
                height={HEIGHT}
                viewBox={`0 0 ${width} ${HEIGHT}`}
                role="img"
                aria-label={`${title} over the selected range. Latest ${fmt(points[lastIdx]?.v)} ${unit}.`}
                tabIndex={0}
                onPointerMove={onPointer}
                onPointerLeave={() => setCursor(null)}
                onKeyDown={onKeyDown}
                style={{ display: 'block', touchAction: 'none', outline: 'none' }}
            >
                <defs>
                    <linearGradient id={`wash-${title.replace(/\W/g, '')}`} x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.1" />
                        <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                    </linearGradient>
                </defs>

                {/* Gridlines: hairline, solid, one step off the surface, recessive. */}
                {ticks.map((t) => (
                    <g key={t}>
                        <line
                            x1={PAD.left}
                            x2={PAD.left + plotW}
                            y1={y(t)}
                            y2={y(t)}
                            stroke="var(--grid)"
                            strokeWidth="1"
                        />
                        <text
                            x={PAD.left - 8}
                            y={y(t) + 4}
                            textAnchor="end"
                            fontSize="11"
                            fill="var(--text-muted)"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {t}
                        </text>
                    </g>
                ))}

                {/* Area wash under each segment - a 10% tint, never a solid block. */}
                {segments.map((seg, i) => (
                    <path
                        key={`a${i}`}
                        d={
                            `M ${seg[0][0]} ${PAD.top + plotH} ` +
                            seg.map(([px, py]) => `L ${px} ${py}`).join(' ') +
                            ` L ${seg[seg.length - 1][0]} ${PAD.top + plotH} Z`
                        }
                        fill={`url(#wash-${title.replace(/\W/g, '')})`}
                    />
                ))}

                {segments.map((seg, i) => (
                    <path
                        key={`l${i}`}
                        d={seg.map(([px, py], j) => `${j ? 'L' : 'M'} ${px} ${py}`).join(' ')}
                        fill="none"
                        stroke={color}
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                ))}

                {/* X labels: first and last only. More would collide at this width,
                    and the crosshair readout carries every time in between. */}
                <text x={PAD.left} y={HEIGHT - 8} fontSize="11" fill="var(--text-muted)">
                    {formatTime(points[0].t, spanHours)}
                </text>
                <text
                    x={PAD.left + plotW}
                    y={HEIGHT - 8}
                    textAnchor="end"
                    fontSize="11"
                    fill="var(--text-muted)"
                >
                    {formatTime(points[points.length - 1].t, spanHours)}
                </text>

                {/* The one direct label: the current value at the line's end. This
                    is also the relief the light-mode contrast warning requires, so
                    it is not optional decoration. */}
                {lastIdx >= 0 ? (
                    <>
                        <circle
                            cx={x(lastIdx)}
                            cy={y(points[lastIdx].v)}
                            r="4.5"
                            fill={color}
                            stroke="var(--surface-1)"
                            strokeWidth="2"
                        />
                        <text
                            x={Math.min(x(lastIdx) + 10, width - 4)}
                            y={y(points[lastIdx].v) + 4}
                            fontSize="12"
                            fontWeight="600"
                            fill="var(--text-primary)"
                        >
                            {fmt(points[lastIdx].v)}
                        </text>
                    </>
                ) : null}

                {/* Crosshair */}
                {cur ? (
                    <>
                        <line
                            x1={curX}
                            x2={curX}
                            y1={PAD.top}
                            y2={PAD.top + plotH}
                            stroke="var(--text-muted)"
                            strokeWidth="1"
                        />
                        {cur.v != null ? (
                            <circle
                                cx={curX}
                                cy={y(cur.v)}
                                r="4.5"
                                fill={color}
                                stroke="var(--surface-1)"
                                strokeWidth="2"
                            />
                        ) : null}
                    </>
                ) : null}
            </svg>

            {/* Tooltip: the value leads as the strong element, the time follows,
                and the series is keyed by a short stroke of its color. */}
            {cur ? (
                <div
                    style={{
                        position: 'absolute',
                        left: Math.max(8, Math.min(curX - 60, width - 140)),
                        top: 42,
                        pointerEvents: 'none',
                        background: 'var(--surface-1)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '8px 10px',
                        boxShadow: '0 4px 14px rgba(0,0,0,0.10)',
                        minWidth: 120,
                    }}
                >
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 7,
                            fontSize: 15,
                            fontWeight: 600,
                            color: 'var(--text-primary)',
                        }}
                    >
                        <span
                            style={{
                                width: 12,
                                height: 2,
                                borderRadius: 2,
                                background: color,
                                flex: 'none',
                            }}
                        />
                        {fmt(cur.v)}
                        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>
                            {unit}
                        </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {new Date(cur.t).toLocaleString([], {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                        })}
                    </div>
                </div>
            ) : null}
            </>
            )}
        </div>
    );
}
