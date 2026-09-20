import React, { useEffect, useMemo, useState } from 'react';
import History from './History.jsx';
import Sparkline from './Sparkline.jsx';

// Two pages, and the split is the whole design. This one is "how is the plant
// right now?": every measure appears exactly once, as a big current number with
// the last two days of shape under it. Anything that needs a chart with axes
// belongs to the other page, behind the history link at the bottom.
//
// 48 hours because that is the window where a reading still implies an action.
// It is long enough to show last night as well as this one, and short enough
// that a dry-down still looks like a slope rather than a flat line.
const LIVE_HOURS = 48;

const SERIES = {
    soil: 'var(--series-soil)',
    temp: 'var(--series-temp)',
    humidity: 'var(--series-humidity)',
    light: 'var(--series-light)',
    rssi: 'var(--text-muted)',
};

// Soil moisture is the only reading that implies an action, so it is the only
// one given a verdict. Status colour never travels alone: each of these ships
// with its own icon and its own words.
function verdictFor(pct) {
    if (pct == null)
        return { text: 'Not calibrated', color: 'var(--text-muted)', icon: 'info', advice: null };
    if (pct < 20)
        return {
            text: 'Needs water',
            color: 'var(--status-critical)',
            icon: 'alert',
            advice: 'Time for a drink.',
        };
    if (pct < 40)
        return {
            text: 'Getting dry',
            color: 'var(--status-warning)',
            icon: 'clock',
            advice: 'Worth a look in the next day or so.',
        };
    return {
        text: 'Comfortable',
        color: 'var(--status-good)',
        icon: 'check',
        advice: 'Nothing needs doing today.',
    };
}

// The header answers "is the node still alive?", so the age of the last reading
// matters more than its wall-clock time. Minutes stay exact up to an hour, then
// the unit widens — nobody needs "just now" resolution on a two-day-old reading.
function relativeAge(iso, now) {
    const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins === 1) return '1 min ago';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? '1 day ago' : `${days} days ago`;
}

// The node publishes every five minutes, so a gap past fifteen means two missed
// slots - long enough to be worth flagging, short enough not to cry wolf. The
// dot only ever restates what the words beside it already say.
function freshnessColor(iso, now) {
    const mins = (now - new Date(iso).getTime()) / 60000;
    if (mins > 60) return 'var(--status-critical)';
    if (mins > 15) return 'var(--status-warning)';
    return 'var(--status-good)';
}

// Soil moisture that climbs more than five points between consecutive samples
// is a watering, not weather - nothing else moves the probe that fast. Only the
// most recent one is named, in words, in the hero note.
const WATERING_JUMP_PCT = 5;

function findWatering(readings) {
    for (let i = readings.length - 1; i > 0; i--) {
        const prev = readings[i - 1].soil_pct;
        const cur = readings[i].soil_pct;
        if (prev != null && cur != null && cur - prev > WATERING_JUMP_PCT) {
            return { index: i, at: readings[i].recorded_at };
        }
    }
    return null;
}

// Real links, not buttons: the back button, middle-click and a pasted URL all
// then work the way a reader expects, for the price of one hashchange listener.
function useHashRoute() {
    const [hash, setHash] = useState(() => window.location.hash);
    useEffect(() => {
        const onChange = () => setHash(window.location.hash);
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, []);
    return hash === '#/history' ? 'history' : 'live';
}

function Icon({ name, color, size = 20 }) {
    const common = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: color,
        strokeWidth: 2.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
    };
    if (name === 'check') return <svg {...common}><path d="M3 8.5l3.2 3.2L13 5" /></svg>;
    if (name === 'alert')
        return (
            <svg {...common}>
                <path d="M8 2.5v7.2" />
                <circle cx="8" cy="13" r="0.9" fill={color} stroke="none" />
            </svg>
        );
    if (name === 'clock')
        return (
            <svg {...common}>
                <circle cx="8" cy="8" r="5.8" />
                <path d="M8 4.8V8l2.4 1.6" />
            </svg>
        );
    return (
        <svg {...common}>
            <circle cx="8" cy="8" r="5.8" />
            <path d="M8 5.4v.1M8 7.6v3.2" />
        </svg>
    );
}

function LeafMark() {
    return (
        <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--status-good)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 21V11" />
            <path d="M12 12C12 7.5 15 4.2 20 3.6c.5 4.9-2.4 8.3-8 8.4Z" />
            <path d="M12 16c-4.3-.1-6.6-2.6-6.2-6.4C9.6 10.1 11.6 12.4 12 16Z" />
        </svg>
    );
}

function Tile({ label, color, value, unit, decimals = 1, points, pending }) {
    return (
        <div className="card">
            <div className="tile-label">
                <span className="key" style={{ background: color }} />
                {label}
            </div>
            <div className="tile-value">
                {pending ? (
                    <span className="skeleton skel-value" />
                ) : (
                    <>
                        {value == null ? '—' : value.toFixed(decimals)}
                        {value == null ? null : <span className="tile-unit">{unit}</span>}
                    </>
                )}
            </div>
            <div className="tile-spark">
                {pending ? (
                    <span className="skeleton skel-spark" />
                ) : (
                    <Sparkline points={points} color={color} />
                )}
            </div>
        </div>
    );
}

export default function App() {
    const route = useHashRoute();
    const [data, setData] = useState(null);
    const [devices, setDevices] = useState([]);
    const [error, setError] = useState(null);
    const [tick, setTick] = useState(0);
    const [now, setNow] = useState(() => Date.now());

    // Fetched on both pages: the history view has its own aggregates, but the
    // header's "last reading 4 min ago" is about the node being alive, which is
    // just as worth knowing while looking backwards.
    useEffect(() => {
        let cancelled = false;
        Promise.all([
            fetch(`/api/readings?device=plant-01&hours=${LIVE_HOURS}`).then((r) => r.json()),
            fetch('/api/devices').then((r) => r.json()),
        ])
            .then(([readings, devs]) => {
                if (cancelled) return;
                setData(readings);
                setDevices(devs);
                setError(null);
            })
            .catch((e) => !cancelled && setError(e.message));
        return () => {
            cancelled = true;
        };
    }, [tick]);

    // Poll at the node's own cadence. Any faster only re-fetches rows that
    // cannot have changed.
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 5 * 60 * 1000);
        return () => clearInterval(id);
    }, []);

    // The age label has to keep counting between fetches, so it gets its own
    // clock rather than riding on the poll.
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 30 * 1000);
        return () => clearInterval(id);
    }, []);

    // The first fetch, when the page knows nothing and must not assert
    // anything - not "no readings", not "not calibrated".
    const pending = data == null && error == null;

    const readings = data?.readings ?? [];
    const latest = readings.length ? readings[readings.length - 1] : null;
    const device = devices.find((d) => d.device_id === (data?.device ?? 'plant-01'));

    const series = useMemo(
        () => ({
            soil: readings.map((r) => ({ t: r.recorded_at, v: r.soil_pct })),
            temp: readings.map((r) => ({ t: r.recorded_at, v: r.air_temp_c })),
            humidity: readings.map((r) => ({ t: r.recorded_at, v: r.humidity_pct })),
            light: readings.map((r) => ({ t: r.recorded_at, v: r.lux })),
            rssi: readings.map((r) => ({ t: r.recorded_at, v: r.rssi })),
        }),
        [readings],
    );

    const verdict = verdictFor(latest?.soil_pct ?? null);
    const watering = useMemo(() => findWatering(readings), [readings]);

    const lastSeenAt = latest
        ? new Date(latest.recorded_at).toLocaleString([], {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
          })
        : null;
    const lastSeenAge = latest ? relativeAge(latest.recorded_at, now) : null;

    // The plant's own name leads, because that is what the reader came for; the
    // device id is only a fallback for a node that has not been labelled.
    const plantName =
        device?.plant && device.plant !== 'unknown' ? device.plant : 'Plant vitals';
    const placeName = device?.label ?? data?.device ?? 'plant-01';

    const heroNote = verdict.advice
        ? watering
            ? `Watered ${relativeAge(watering.at, now)}. ${verdict.advice}`
            : verdict.advice
        : null;

    return (
        <div className="wrap">
            <header>
                <div className="brand">
                    <span className="brand-mark">
                        <LeafMark />
                    </span>
                    <div>
                        <h1>{pending ? <span className="skeleton skel-title" /> : plantName}</h1>
                        <div className="brand-sub">
                            {pending ? <span className="skeleton skel-sub" /> : placeName}
                        </div>
                    </div>
                </div>
                <div className="lastseen" title={lastSeenAt ?? undefined}>
                    <span
                        className="dot"
                        style={{
                            background:
                                latest && !pending
                                    ? freshnessColor(latest.recorded_at, now)
                                    : 'var(--text-muted)',
                        }}
                    />
                    {pending
                        ? 'Checking…'
                        : error && data == null
                          ? 'Unavailable'
                          : latest
                            ? `Last reading ${lastSeenAge}`
                            : 'No readings yet'}
                </div>
            </header>

            {error ? (
                <div className="card" style={{ marginBottom: 16 }}>
                    <strong>Cannot reach the API.</strong>{' '}
                    <span style={{ color: 'var(--text-muted)' }}>{error}</span>
                </div>
            ) : null}

            {route === 'history' ? (
                <>
                    <div className="view-switch">
                        <a className="pagelink" href="#/">
                            <span aria-hidden="true">←</span> Back to now
                        </a>
                        <h2 className="view-title">The long view</h2>
                    </div>
                    <History device={data?.device ?? 'plant-01'} series={SERIES} />
                </>
            ) : error && data == null ? null : (
                <>
                    <div className="hero-card">
                        <div className="hero">
                            <div>
                                <div className="hero-label">Soil moisture</div>
                                {/* With no reading at all there is no value slot
                                    either: an em dash at 132px is a white bar,
                                    which reads as a skeleton that never resolved
                                    rather than as "nothing to report". The
                                    sentence below says it in words instead. */}
                                {pending ? (
                                    <div className="hero-value">
                                        <span className="skeleton skel-hero" />
                                    </div>
                                ) : latest == null ? null : (
                                    <div className="hero-value">
                                        {latest.soil_pct == null
                                            ? '—'
                                            : `${latest.soil_pct.toFixed(0)}%`}
                                    </div>
                                )}
                            </div>
                            {/* No verdict until there is a reading to have one
                                about - an empty window is not a dry plant, and
                                it is not an uncalibrated probe either. */}
                            {pending || latest == null ? null : (
                                <span className="verdict">
                                    <Icon name={verdict.icon} color={verdict.color} />
                                    {verdict.text}
                                </span>
                            )}
                        </div>

                        {pending ? (
                            <div className="meter">
                                <div style={{ width: 0 }} />
                            </div>
                        ) : latest == null ? (
                            <div className="hero-aside">
                                Nothing has arrived in the last {LIVE_HOURS} hours. Either the
                                node has stopped publishing, or it has not been running that
                                long yet.
                            </div>
                        ) : latest.soil_pct != null ? (
                            <>
                                <div className="meter">
                                    <div
                                        style={{
                                            // The number can read past 100% (see
                                            // soilPercent in server/index.js), but the
                                            // bar is a fraction of its own box and has
                                            // nowhere to go past full width.
                                            width: `${Math.min(100, Math.max(2, latest.soil_pct))}%`,
                                            background: verdict.color,
                                        }}
                                    />
                                </div>
                                {/* The lead measure gets the same trend cue the tiles
                                    get, so dropping the chart grid does not cost the
                                    dry-down its shape. */}
                                <div className="hero-spark">
                                    <Sparkline
                                        points={series.soil}
                                        color={SERIES.soil}
                                        ring="var(--surface-hero)"
                                    />
                                </div>
                                {heroNote ? <div className="hero-note">{heroNote}</div> : null}
                            </>
                        ) : (
                            <div className="hero-aside">
                                The probe has no calibration yet, so a percentage would be
                                meaningless. Record the raw value in air and in water, then set{' '}
                                <code>soil_raw_air</code> and <code>soil_raw_water</code> on the
                                device row. Latest raw reading:{' '}
                                <strong>{latest?.soil_raw ?? '—'}</strong>.
                            </div>
                        )}
                    </div>

                    <div className="tiles">
                        <Tile
                            label="Air temperature"
                            color={SERIES.temp}
                            value={latest?.air_temp_c ?? null}
                            unit="°C"
                            points={series.temp}
                            pending={pending}
                        />
                        <Tile
                            label="Humidity"
                            color={SERIES.humidity}
                            value={latest?.humidity_pct ?? null}
                            unit="%"
                            points={series.humidity}
                            pending={pending}
                        />
                        <Tile
                            label="Light"
                            color={SERIES.light}
                            value={latest?.lux ?? null}
                            unit="lux"
                            decimals={0}
                            points={series.light}
                            pending={pending}
                        />
                        <Tile
                            label="WiFi signal"
                            color={SERIES.rssi}
                            value={latest?.rssi ?? null}
                            unit="dBm"
                            decimals={0}
                            points={series.rssi}
                            pending={pending}
                        />
                    </div>

                    <div className="live-foot">
                        <span className="live-foot-note">
                            Everything above is the last {LIVE_HOURS} hours.
                        </span>
                        <a className="pagelink pagelink-strong" href="#/history">
                            Look back further <span aria-hidden="true">→</span>
                        </a>
                    </div>
                </>
            )}
        </div>
    );
}
