import React, { useEffect, useMemo, useState } from 'react';
import { readSaved, savedAtText, writeSaved } from './savedCopy.js';
import TimeSeries from './TimeSeries.jsx';

// The long view. The live page answers "does the plant need anything right
// now?" and deliberately shows only the last two days; this one answers the
// slower questions - is the room drying out as winter comes on, has the
// watering rhythm changed, was last summer brighter than this one.
//
// Nothing here is a second copy of the live page. Same four measures, but every
// mark is an aggregate over hours or days, which is a different reading of the
// same data rather than a repeat of it.

const RANGES = [
    { key: '1m', label: '1 month' },
    { key: '3m', label: '3 months' },
    { key: '6m', label: '6 months' },
    { key: '12m', label: '12 months' },
    { key: 'all', label: 'All time' },
];

// The server picks the bucket from the span, so the caption has to be able to
// name whatever it picked rather than assuming days.
function bucketLabel(seconds) {
    if (seconds < 3600) return `${Math.round(seconds / 60)}-minute`;
    const hours = seconds / 3600;
    if (hours < 24) return hours === 1 ? 'hourly' : `${Math.round(hours)}-hour`;
    const days = Math.round(seconds / 86400);
    if (days === 1) return 'daily';
    if (days === 7) return 'weekly';
    return `${days}-day`;
}

function shortDate(iso) {
    return new Date(iso).toLocaleDateString([], {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
}

export default function History({ device, series }) {
    const [range, setRange] = useState('3m');
    // What is on screen, and which range and source it came from:
    // { range, data, source: 'saved' | 'network', savedAt? }.
    const [shown, setShown] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // The saved copy of this range is drawn at once, dimmed like any refetch,
    // and the network's answer replaces it. A saved copy that turns up after
    // the network has answered is dropped: it is only ever older. One that
    // turns up after the network failed is exactly what it is kept for.
    useEffect(() => {
        let cancelled = false;
        let fetched = false;
        const key = `history?device=${encodeURIComponent(device)}&range=${range}`;
        setLoading(true);
        readSaved(key).then((saved) => {
            if (cancelled || fetched || !saved?.data) return;
            setShown({ range, data: saved.data, source: 'saved', savedAt: saved.savedAt });
        });
        fetch(`/api/history?device=${encodeURIComponent(device)}&range=${range}`)
            .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))))
            .then((d) => {
                fetched = true;
                if (cancelled) return;
                setShown({ range, data: d, source: 'network' });
                setError(null);
                writeSaved(key, { data: d });
            })
            .catch((e) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [device, range]);

    // The previous range stays up, dimmed, while the next one loads. Once that
    // load has failed with nothing saved for it, the old range's charts would
    // sit under the new range's button, so they go.
    const data = shown && (shown.range === range || loading) ? shown.data : null;

    // Same two loadings as the live page: `pending` knows nothing and must not
    // claim anything, `refetching` still has a true previous render to hold.
    const pending = data == null && error == null;
    const refetching = loading && data != null;

    const buckets = data?.buckets ?? [];

    const points = useMemo(() => {
        const of = (avg, min, max) =>
            buckets.map((b) => ({ t: b.t, v: b[avg], lo: b[min], hi: b[max] }));
        return {
            soil: of('soil_pct_avg', 'soil_pct_min', 'soil_pct_max'),
            temp: of('air_temp_c_avg', 'air_temp_c_min', 'air_temp_c_max'),
            humidity: of('humidity_pct_avg', 'humidity_pct_min', 'humidity_pct_max'),
        };
    }, [buckets]);

    // Buckets are evenly spaced, so a missing one means a stretch with no
    // readings at all, and the line breaks across it.
    const maxGapMs = data ? data.bucketSeconds * 1000 * 1.5 : Infinity;

    const spanHours = data ? (new Date(data.to) - new Date(data.from)) / 3600000 : 24 * 90;

    // Asking for a year of a three-day-old plant is not an error, but saying so
    // beats drawing a year-wide axis with a thumbnail of data at the right edge.
    const shortHistory =
        data?.firstReading && range !== 'all'
            ? new Date(data.firstReading) > new Date(data.from)
            : false;

    return (
        <>
            <div className="filters">
                {RANGES.map((r) => (
                    <button
                        key={r.key}
                        aria-pressed={range === r.key}
                        onClick={() => setRange(r.key)}
                    >
                        {r.label}
                    </button>
                ))}
            </div>

            {error ? (
                <div className="card" style={{ marginBottom: 16 }}>
                    <strong>Cannot load the history.</strong>{' '}
                    <span style={{ color: 'var(--text-muted)' }}>
                        {error}.
                        {data != null && shown?.source === 'saved'
                            ? ` Showing the copy saved on this device ${savedAtText(shown.savedAt)}.`
                            : null}
                    </span>
                </div>
            ) : null}

            {pending ? (
                <div className="range-note">
                    <span className="skeleton skel-sub" />
                </div>
            ) : data?.firstReading ? (
                <div className="range-note">
                    Each point is a {bucketLabel(data.bucketSeconds)} average, and the
                    shaded band is that period's low and high.
                    {shortHistory
                        ? ` There is only history back to ${shortDate(data.firstReading)} so far.`
                        : range === 'all'
                          ? ` Recording since ${shortDate(data.firstReading)}.`
                          : ''}
                </div>
            ) : null}

            {error && data == null ? null : (
                <div className={`grid ${refetching ? 'reloading' : ''}`}>
                    <TimeSeries
                        className="span-2"
                        title="Soil moisture"
                        unit="%"
                        color={series.soil}
                        points={points.soil}
                        maxGapMs={maxGapMs}
                        spanHours={spanHours}
                        decimals={0}
                        height={250}
                        pending={pending}
                    />
                    <TimeSeries
                        title="Air temperature"
                        unit="°C"
                        color={series.temp}
                        points={points.temp}
                        maxGapMs={maxGapMs}
                        spanHours={spanHours}
                        pending={pending}
                    />
                    <TimeSeries
                        title="Humidity"
                        unit="%"
                        color={series.humidity}
                        points={points.humidity}
                        maxGapMs={maxGapMs}
                        spanHours={spanHours}
                        pending={pending}
                    />
                </div>
            )}
        </>
    );
}
