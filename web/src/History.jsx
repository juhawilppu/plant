import React, { useEffect, useMemo, useState } from 'react';
import { readSaved, savedAtText, writeSaved } from './savedCopy.js';
import TimeSeries from './TimeSeries.jsx';
import { rangeText } from './when.js';

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

const DEFAULT_RANGE = '3m';

// Narrower than this, even the server's one-minute buckets are too few to make
// a line (the server widens a narrower ask to the same span).
const MIN_SPAN_MS = 15 * 60 * 1000;

// The node reports once a minute, so this much silence is an outage. Buckets
// finer than a few minutes can come back empty just from a reading landing a
// few seconds either side of an edge, and the line must not break for that.
const OUTAGE_MS = 5 * 60 * 1000;

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

// --- what is on screen: a preset, or a range of the reader's own ----------
//
// Either { range: '3m' } or { from, to } in ms. It lives in the URL
// (/history?range=6m, /history?from=...&to=...), so a zoomed-in view can be
// bookmarked or sent, and each zoom is a history entry: the back button
// zooms back out, the way it undoes any other step.

const minuteIso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';

function viewFromUrl() {
    const q = new URLSearchParams(window.location.search);
    const from = Date.parse(q.get('from') ?? '');
    const to = Date.parse(q.get('to') ?? '');
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) return { from, to };
    const range = q.get('range');
    return { range: RANGES.some((r) => r.key === range) ? range : DEFAULT_RANGE };
}

function queryOf(view) {
    return view.range
        ? `range=${view.range}`
        : `from=${minuteIso(view.from)}&to=${minuteIso(view.to)}`;
}

function urlOf(view) {
    return view.range === DEFAULT_RANGE ? '/history' : `/history?${queryOf(view)}`;
}

// A custom view on whole minutes, at least MIN_SPAN_MS wide, and not reaching
// past now: a range dragged out on a chart lands on arbitrary milliseconds,
// and a URL full of them helps nobody.
function customView(fromMs, toMs, now = Date.now()) {
    let from = Math.floor(fromMs / 60000) * 60000;
    let to = Math.ceil(toMs / 60000) * 60000;
    if (to - from < MIN_SPAN_MS) {
        const mid = (from + to) / 2;
        from = Math.floor((mid - MIN_SPAN_MS / 2) / 60000) * 60000;
        to = from + MIN_SPAN_MS;
    }
    if (to > now) {
        from -= to - Math.ceil(now / 60000) * 60000;
        to = Math.ceil(now / 60000) * 60000;
    }
    return { from, to };
}

function useView() {
    const [view, setViewState] = useState(viewFromUrl);

    useEffect(() => {
        const onPop = () => {
            if (window.location.pathname === '/history') setViewState(viewFromUrl());
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    const setView = (next) => {
        const url = urlOf(next);
        if (url !== window.location.pathname + window.location.search) {
            window.history.pushState(null, '', url);
        }
        setViewState(next);
    };
    return [view, setView];
}

// datetime-local speaks the viewer's local time, without a zone.
function localInput(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Two date fields for the range, which is also the way to zoom on a phone or
// from the keyboard, where dragging across a chart is not an option. They
// show whatever is on screen, so a preset or a dragged zoom can be nudged from
// where it is rather than typed from scratch.
function RangeForm({ shownFrom, shownTo, onApply }) {
    const [draft, setDraft] = useState({ from: '', to: '' });
    const [edited, setEdited] = useState(false);

    useEffect(() => {
        if (shownFrom == null || shownTo == null) return;
        setDraft({ from: localInput(shownFrom), to: localInput(shownTo) });
        setEdited(false);
    }, [shownFrom, shownTo]);

    const from = draft.from ? new Date(draft.from).getTime() : NaN;
    const to = draft.to ? new Date(draft.to).getTime() : NaN;
    const problem =
        !Number.isFinite(from) || !Number.isFinite(to)
            ? 'Pick both a start and an end.'
            : from >= to
              ? 'The start has to be before the end.'
              : to - from < MIN_SPAN_MS
                ? 'Pick at least 15 minutes.'
                : from >= Date.now()
                  ? 'That range has not happened yet.'
                  : null;

    const edit = (key) => (e) => {
        setDraft({ ...draft, [key]: e.target.value });
        setEdited(true);
    };

    const onSubmit = (e) => {
        e.preventDefault();
        if (!problem) onApply(from, to);
    };

    // No min or max on the fields: the browser would refuse a range that only
    // overhangs the history there is, or ends a few seconds past now, and both
    // are fine to ask for - the server trims them to what exists.
    return (
        <form className="custom-range" onSubmit={onSubmit}>
            <label>
                From
                <input type="datetime-local" value={draft.from} onChange={edit('from')} />
            </label>
            <label>
                To
                <input type="datetime-local" value={draft.to} onChange={edit('to')} />
            </label>
            <button type="submit" disabled={!edited || problem != null}>
                Show this range
            </button>
            {edited && problem ? (
                <div className="custom-range-error" role="alert">
                    {problem}
                </div>
            ) : null}
        </form>
    );
}

export default function History({ device, series }) {
    const [view, setView] = useView();
    const query = queryOf(view);
    // What is on screen, and which view and source it came from:
    // { query, data, source: 'saved' | 'network', savedAt? }.
    const [shown, setShown] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // The saved copy of this range is drawn at once, dimmed like any refetch,
    // and the network's answer replaces it. A saved copy that turns up after
    // the network has answered is dropped: it is only ever older. One that
    // turns up after the network failed is exactly what it is kept for.
    //
    // Only the presets are saved. Every zoom is a range of its own, and saving
    // each one would grow the cache without end for views rarely seen twice.
    useEffect(() => {
        let cancelled = false;
        let fetched = false;
        const key = `history?device=${encodeURIComponent(device)}&${query}`;
        const preset = query.startsWith('range=');
        setLoading(true);
        if (preset) {
            readSaved(key).then((saved) => {
                if (cancelled || fetched || !saved?.data) return;
                setShown({ query, data: saved.data, source: 'saved', savedAt: saved.savedAt });
            });
        }
        fetch(`/api/${key}`)
            .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))))
            .then((d) => {
                fetched = true;
                if (cancelled) return;
                setShown({ query, data: d, source: 'network' });
                setError(null);
                if (preset) writeSaved(key, { data: d });
            })
            .catch((e) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [device, query]);

    // The previous range stays up, dimmed, while the next one loads. Once that
    // load has failed with nothing saved for it, the old range's charts would
    // sit under the new range's button, so they go.
    const data = shown && (shown.query === query || loading) ? shown.data : null;

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
    // readings at all, and the line breaks across it - unless the buckets are
    // so fine that a missing one is just a reading landing either side of an
    // edge.
    const maxGapMs = data ? Math.max(data.bucketSeconds * 1000 * 1.5, OUTAGE_MS) : Infinity;

    const spanHours = data ? (new Date(data.to) - new Date(data.from)) / 3600000 : 24 * 90;

    // Asking for a year of a three-day-old plant is not an error, but saying so
    // beats drawing a year-wide axis with a thumbnail of data at the right edge.
    const shortHistory =
        data?.firstReading && view.range !== 'all'
            ? new Date(data.firstReading) > new Date(data.from)
            : false;

    const shownFrom = data ? Date.parse(data.from) : null;
    const shownTo = data ? Date.parse(data.to) : null;

    // The time axis runs from the first bucket's start to the last one's, so a
    // drag that reaches the right edge means "up to the end", not "up to where
    // the last bucket begins".
    const zoomTo = (fromMs, toMs) => {
        const lastT = buckets.length ? Date.parse(buckets[buckets.length - 1].t) : null;
        const end = lastT != null && toMs >= lastT && shownTo != null ? shownTo : toMs;
        setView(customView(fromMs, end));
    };

    // Twice as wide about the same middle, kept inside the history there is.
    // Once it would cover all of it, it is simply "All time".
    const zoomOut = () => {
        const now = Date.now();
        const span = (view.to - view.from) * 2;
        const first = data?.firstReading ? Date.parse(data.firstReading) : -Infinity;
        let to = Math.min(now, (view.from + view.to) / 2 + span / 2);
        let from = to - span;
        if (from < first) {
            from = first;
            to = Math.min(now, first + span);
        }
        if (from <= first && to >= now - 60000) setView({ range: 'all' });
        else setView(customView(from, to, now));
    };

    return (
        <>
            <div className="filters">
                {RANGES.map((r) => (
                    <button
                        key={r.key}
                        aria-pressed={view.range === r.key}
                        onClick={() => setView({ range: r.key })}
                    >
                        {r.label}
                    </button>
                ))}
            </div>

            {view.range ? null : (
                <div className="zoom-bar">
                    <span className="zoom-bar-range">{rangeText(view.from, view.to)}</span>
                    <button type="button" onClick={zoomOut}>
                        Zoom out
                    </button>
                </div>
            )}

            <RangeForm
                shownFrom={shownFrom}
                shownTo={shownTo}
                onApply={(from, to) => setView(customView(from, to))}
            />

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
                        : view.range === 'all'
                          ? ` Recording since ${shortDate(data.firstReading)}.`
                          : ''}
                    <span className="hint-pointer"> Drag across a chart to zoom in.</span>
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
                        bucketSeconds={data?.bucketSeconds}
                        onZoom={zoomTo}
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
                        bucketSeconds={data?.bucketSeconds}
                        onZoom={zoomTo}
                        pending={pending}
                    />
                    <TimeSeries
                        title="Humidity"
                        unit="%"
                        color={series.humidity}
                        points={points.humidity}
                        maxGapMs={maxGapMs}
                        spanHours={spanHours}
                        bucketSeconds={data?.bucketSeconds}
                        onZoom={zoomTo}
                        pending={pending}
                    />
                </div>
            )}
        </>
    );
}
