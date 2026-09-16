import React, { useEffect, useMemo, useState } from 'react';
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
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetch(`/api/history?device=${encodeURIComponent(device)}&range=${range}`)
            .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))))
            .then((d) => {
                if (cancelled) return;
                setData(d);
                setError(null);
            })
            .catch((e) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [device, range]);

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
            light: of('lux_avg', 'lux_min', 'lux_max'),
        };
    }, [buckets]);

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
                    <span style={{ color: 'var(--text-muted)' }}>{error}</span>
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
                        spanHours={spanHours}
                        pending={pending}
                    />
                    <TimeSeries
                        title="Humidity"
                        unit="%"
                        color={series.humidity}
                        points={points.humidity}
                        spanHours={spanHours}
                        pending={pending}
                    />
                    <TimeSeries
                        title="Light"
                        unit="lux"
                        color={series.light}
                        points={points.light}
                        spanHours={spanHours}
                        decimals={0}
                        pending={pending}
                    />
                </div>
            )}
        </>
    );
}
