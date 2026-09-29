import React, { useCallback, useMemo, useState } from 'react';
import useWidth, { gapBefore, linePath, segmentsOf, timeScale, useTapAway } from './useWidth.js';
import { bucketSpan, exactTime } from './when.js';

// One measure over time, hand-rolled in SVG rather than pulled from a chart
// library: the mark specs here (2.6px line, >=10px end dot with a surface ring,
// hairline solid gridlines, area wash, a single direct end-label) are easier to
// hold exactly than to argue a library into.
//
// Always a SINGLE series, so there is no legend - the card's title names what is
// plotted, and a one-swatch legend would only restate it. Two measures never
// share these axes: a second y-scale is the one thing this file will not do.
//
// A point may carry `lo`/`hi` as well as `v`. That is the long-term view, where
// each mark is an average over hours or days: the band behind the line is the
// spread that average hides, drawn in the same hue so it reads as the same
// series rather than as a second one.

const PAD = { top: 18, right: 70, bottom: 32, left: 56 };

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
    // Past a few months the day of the month stops carrying information and the
    // year starts to, so the label widens rather than repeating "3 Mar".
    if (spanHours > 24 * 120) {
        return d.toLocaleDateString([], { month: 'short', year: 'numeric' });
    }
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export default function TimeSeries({
    title,
    unit,
    color,
    points, // [{ t: ISO string, v: number | null, lo?: number, hi?: number }]
    spanHours,
    decimals = 1,
    height = 200,
    markers = [], // [{ index, label }] - events worth naming on the x axis
    bandLabel = 'low to high', // what lo/hi mean, for the tooltip and the label
    pending = false, // first fetch still in flight: no data, and no claim either
    maxGapMs = Infinity, // neighbours further apart than this have missing data between them
    bucketSeconds = null, // each point averages this long from its `t`; null for single readings
    className = '',
}) {
    const [hostRef, width] = useWidth(640, 260);
    const [cursor, setCursor] = useState(null); // index into points
    const clearCursor = useCallback(() => setCursor(null), []);
    useTapAway(hostRef, cursor != null, clearCursor);

    const withValues = useMemo(() => points.filter((p) => p.v != null), [points]);

    const hasBand = useMemo(
        () => points.some((p) => p.lo != null && p.hi != null),
        [points],
    );

    const { lo, hi, ticks } = useMemo(() => {
        const vals = [];
        for (const p of withValues) {
            vals.push(p.v);
            if (p.lo != null) vals.push(p.lo);
            if (p.hi != null) vals.push(p.hi);
        }
        return niceScale(Math.min(...vals), Math.max(...vals));
    }, [withValues]);

    const plotW = Math.max(10, width - PAD.left - PAD.right);
    const plotH = height - PAD.top - PAD.bottom;

    const { x, indexAt } = useMemo(() => timeScale(points, PAD.left, plotW), [points, plotW]);
    const y = useCallback(
        (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH,
        [lo, hi, plotH],
    );

    const segments = useMemo(
        () => segmentsOf(points, x, y, maxGapMs),
        [points, x, y, maxGapMs],
    );

    // The band breaks exactly where the line does: a bucket with no samples has
    // no average and no spread either, so neither is drawn across the gap -
    // whether the bucket came back empty or did not come back at all.
    const bandPaths = useMemo(() => {
        if (!hasBand) return [];
        const runs = [];
        let run = [];
        points.forEach((p, i) => {
            if (run.length && gapBefore(points, i, maxGapMs)) {
                runs.push(run);
                run = [];
            }
            if (p.lo == null || p.hi == null) {
                if (run.length) runs.push(run);
                run = [];
            } else {
                run.push([x(i), y(p.hi), y(p.lo)]);
            }
        });
        if (run.length) runs.push(run);
        return runs.map(
            (seg) =>
                seg.map(([px, yh], j) => `${j ? 'L' : 'M'} ${px} ${yh}`).join(' ') +
                ' ' +
                [...seg]
                    .reverse()
                    .map(([px, , yl]) => `L ${px} ${yl}`)
                    .join(' ') +
                ' Z',
        );
    }, [points, x, y, hasBand, maxGapMs]);

    const lastIdx = useMemo(() => {
        for (let i = points.length - 1; i >= 0; i--) if (points[i].v != null) return i;
        return -1;
    }, [points]);

    const fmt = (v) => (v == null ? '—' : v.toFixed(decimals));
    const washId = `wash-${title.replace(/\W/g, '')}`;

    const onPointer = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * width;
        // The crosshair snaps to the nearest data position, so the reader aims
        // at a time rather than at a 2px line.
        setCursor(indexAt(px));
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

    // A refetch can bring fewer points than the cursor was pointing into.
    const cur = cursor != null && cursor < points.length ? points[cursor] : null;
    const curX = cur ? x(cursor) : 0;

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

            {pending ? (
                <span className="skeleton skel-chart" style={{ height }} />
            ) : !withValues.length ? (
                <div className="empty">No readings in this range</div>
            ) : (
            <>

            <svg
                width="100%"
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                role="img"
                aria-label={
                    `${title} over the selected range. Latest ${fmt(points[lastIdx]?.v)} ${unit}.` +
                    (hasBand ? ` The shaded band is each point's ${bandLabel}.` : '')
                }
                tabIndex={0}
                onPointerDown={onPointer}
                onPointerMove={onPointer}
                // A finger lifting also leaves, and the readout it asked for
                // would vanish with it; a tap elsewhere clears that one.
                onPointerLeave={(e) => e.pointerType !== 'touch' && setCursor(null)}
                onPointerCancel={() => setCursor(null)}
                onKeyDown={onKeyDown}
                style={{ display: 'block', touchAction: 'none', outline: 'none' }}
            >
                <defs>
                    <linearGradient id={washId} x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.16" />
                        <stop offset="100%" stopColor={color} stopOpacity="0.01" />
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
                            x={PAD.left - 10}
                            y={y(t) + 5}
                            textAnchor="end"
                            fontSize="15"
                            fontWeight="600"
                            fill="var(--text-muted)"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {t}
                        </text>
                    </g>
                ))}

                {/* The band replaces the wash rather than joining it: two tints of
                    the same hue stacked would read as a third value. */}
                {hasBand
                    ? bandPaths.map((d, i) => (
                          <path key={`b${i}`} d={d} fill={color} fillOpacity="0.17" />
                      ))
                    : segments.map((seg, i) => (
                          <path
                              key={`a${i}`}
                              d={
                                  `M ${seg[0][0]} ${PAD.top + plotH} ` +
                                  seg.map(([px, py]) => `L ${px} ${py}`).join(' ') +
                                  ` L ${seg[seg.length - 1][0]} ${PAD.top + plotH} Z`
                              }
                              fill={`url(#${washId})`}
                          />
                      ))}

                {segments.map((seg, i) => (
                    <path
                        key={`l${i}`}
                        d={linePath(seg)}
                        fill="none"
                        stroke={color}
                        strokeWidth="2.6"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                ))}

                {/* Named events - a watering shows up as a step the reader would
                    otherwise have to interpret, so it gets said in words. */}
                {markers.map((m) => (
                    <g key={`m${m.index}`}>
                        <line
                            x1={x(m.index)}
                            x2={x(m.index)}
                            y1={PAD.top}
                            y2={PAD.top + plotH}
                            stroke="var(--text-muted)"
                            strokeWidth="1.5"
                            strokeDasharray="3 5"
                        />
                        <text
                            x={x(m.index) + 9}
                            y={PAD.top + 17}
                            fontSize="15"
                            fontWeight="600"
                            fill="var(--text-secondary)"
                        >
                            {m.label}
                        </text>
                    </g>
                ))}

                {/* X labels: first and last only. More would collide at this width,
                    and the crosshair readout carries every time in between. */}
                <text
                    x={PAD.left}
                    y={height - 8}
                    fontSize="15"
                    fontWeight="600"
                    fill="var(--text-muted)"
                >
                    {formatTime(points[0].t, spanHours)}
                </text>
                <text
                    x={PAD.left + plotW}
                    y={height - 8}
                    textAnchor="end"
                    fontSize="15"
                    fontWeight="600"
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
                            r="5.5"
                            fill={color}
                            stroke="var(--surface-1)"
                            strokeWidth="3"
                        />
                        <text
                            x={Math.min(x(lastIdx) + 13, width - 4)}
                            y={y(points[lastIdx].v) + 7}
                            fontSize="19"
                            fontWeight="800"
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
                                r="5.5"
                                fill={color}
                                stroke="var(--surface-1)"
                                strokeWidth="3"
                            />
                        ) : null}
                    </>
                ) : null}
            </svg>

            {/* Tooltip: the value leads as the strong element, the time follows,
                and the series is keyed by a short stroke of its color. The time
                is exact: a single reading's moment, or the whole stretch an
                average covers. It opens away from the nearer edge. */}
            <div aria-live="polite">
                {cur ? (
                    <div
                        className="chart-readout"
                        style={{
                            top: 46,
                            ...(curX < width / 2
                                ? { left: Math.max(8, curX - 70) }
                                : { right: Math.max(8, width - curX - 70) }),
                        }}
                    >
                        <div className="chart-readout-value">
                            <span className="chart-readout-key" style={{ background: color }} />
                            {fmt(cur.v)}
                            <span className="chart-readout-unit">{unit}</span>
                        </div>
                        {cur.lo != null && cur.hi != null ? (
                            <div className="chart-readout-band">
                                {fmt(cur.lo)}–{fmt(cur.hi)} {bandLabel}
                            </div>
                        ) : null}
                        <div className="chart-readout-time">
                            {bucketSeconds ? bucketSpan(cur.t, bucketSeconds) : exactTime(cur.t)}
                        </div>
                    </div>
                ) : null}
            </div>
            </>
            )}
        </div>
    );
}
