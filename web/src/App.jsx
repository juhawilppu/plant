import React, { useEffect, useMemo, useState } from 'react';
import TimeSeries from './TimeSeries.jsx';

const RANGES = [
    { label: '24 hours', hours: 24 },
    { label: '7 days', hours: 24 * 7 },
    { label: '30 days', hours: 24 * 30 },
];

const SERIES = {
    soil: 'var(--series-soil)',
    temp: 'var(--series-temp)',
    humidity: 'var(--series-humidity)',
    light: 'var(--series-light)',
};

// Soil moisture is the only reading that implies an action, so it is the only
// one given a verdict. Status colour never travels alone: each of these ships
// with its own icon and its own words.
function verdictFor(pct) {
    if (pct == null) return { text: 'Not calibrated', color: 'var(--text-muted)', icon: 'info' };
    if (pct < 25) return { text: 'Needs water', color: 'var(--status-critical)', icon: 'alert' };
    if (pct < 40) return { text: 'Getting dry', color: 'var(--status-warning)', icon: 'clock' };
    return { text: 'Comfortable', color: 'var(--status-good)', icon: 'check' };
}

function Icon({ name, color }) {
    const common = {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: color,
        strokeWidth: 2,
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

function Tile({ label, color, value, unit, decimals = 1 }) {
    return (
        <div className="card">
            <div className="tile-label">
                <span className="key" style={{ background: color }} />
                {label}
            </div>
            <div className="tile-value">
                {value == null ? '—' : value.toFixed(decimals)}
                {value == null ? null : <span className="tile-unit">{unit}</span>}
            </div>
        </div>
    );
}

export default function App() {
    const [hours, setHours] = useState(24);
    const [data, setData] = useState(null);
    const [devices, setDevices] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showTable, setShowTable] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        Promise.all([
            fetch(`/api/readings?device=plant-01&hours=${hours}`).then((r) => r.json()),
            fetch('/api/devices').then((r) => r.json()),
        ])
            .then(([readings, devs]) => {
                if (cancelled) return;
                setData(readings);
                setDevices(devs);
                setError(null);
            })
            .catch((e) => !cancelled && setError(e.message))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [hours]);

    // Poll at the node's own cadence. Any faster only re-fetches rows that
    // cannot have changed.
    useEffect(() => {
        const id = setInterval(() => setHours((h) => h), 5 * 60 * 1000);
        return () => clearInterval(id);
    }, []);

    const readings = data?.readings ?? [];
    const latest = readings.length ? readings[readings.length - 1] : null;
    const device = devices.find((d) => d.device_id === (data?.device ?? 'plant-01'));

    const series = useMemo(
        () => ({
            soil: readings.map((r) => ({ t: r.recorded_at, v: r.soil_pct })),
            temp: readings.map((r) => ({ t: r.recorded_at, v: r.air_temp_c })),
            humidity: readings.map((r) => ({ t: r.recorded_at, v: r.humidity_pct })),
            light: readings.map((r) => ({ t: r.recorded_at, v: r.lux })),
        }),
        [readings],
    );

    const verdict = verdictFor(latest?.soil_pct ?? null);

    const lastSeen = latest
        ? new Date(latest.recorded_at).toLocaleString([], {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
          })
        : null;

    return (
        <div className="wrap">
            <header>
                <div>
                    <h1>Plant vitals</h1>
                    <div className="subtle">
                        {device ? `${device.label}${device.plant && device.plant !== 'unknown' ? ` · ${device.plant}` : ''}` : 'plant-01'}
                    </div>
                </div>
                <div className="subtle">{lastSeen ? `Last reading ${lastSeen}` : 'No readings yet'}</div>
            </header>

            {error ? (
                <div className="card" style={{ marginBottom: 16 }}>
                    <strong>Cannot reach the API.</strong>{' '}
                    <span className="subtle">{error}</span>
                </div>
            ) : null}

            <div className={`card ${loading ? 'reloading' : ''}`} style={{ marginBottom: 24 }}>
                <div className="hero">
                    <div>
                        <div className="hero-label">Soil moisture</div>
                        <div className="hero-value">
                            {latest?.soil_pct == null ? '—' : `${latest.soil_pct.toFixed(0)}%`}
                        </div>
                    </div>
                    <div style={{ paddingBottom: 6 }}>
                        <span className="verdict">
                            <Icon name={verdict.icon} color={verdict.color} />
                            {verdict.text}
                        </span>
                    </div>
                </div>

                {latest?.soil_pct != null ? (
                    <div className="meter">
                        <div
                            style={{
                                width: `${Math.max(2, latest.soil_pct)}%`,
                                background: verdict.color,
                            }}
                        />
                    </div>
                ) : (
                    <div className="subtle" style={{ marginTop: 10 }}>
                        The probe has no calibration yet, so a percentage would be meaningless.
                        Record the raw value in air and in water, then set{' '}
                        <code>soil_raw_air</code> and <code>soil_raw_water</code> on the device
                        row. Latest raw reading: <strong>{latest?.soil_raw ?? '—'}</strong>.
                    </div>
                )}
            </div>

            <div className="tiles">
                <Tile label="Air temperature" color={SERIES.temp} value={latest?.air_temp_c ?? null} unit="°C" />
                <Tile label="Humidity" color={SERIES.humidity} value={latest?.humidity_pct ?? null} unit="%" />
                <Tile label="Light" color={SERIES.light} value={latest?.lux ?? null} unit="lux" decimals={0} />
                <Tile label="WiFi signal" color="var(--text-muted)" value={latest?.rssi ?? null} unit="dBm" decimals={0} />
            </div>

            <div className="filters">
                {RANGES.map((r) => (
                    <button
                        key={r.hours}
                        aria-pressed={hours === r.hours}
                        onClick={() => setHours(r.hours)}
                    >
                        {r.label}
                    </button>
                ))}
                <div className="spacer" />
                <button aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>
                    {showTable ? 'Hide table' : 'Table view'}
                </button>
            </div>

            <div className={`grid ${loading ? 'reloading' : ''}`}>
                <TimeSeries
                    className="span-2"
                    title="Soil moisture"
                    unit="%"
                    color={SERIES.soil}
                    points={series.soil}
                    spanHours={hours}
                    decimals={0}
                />
                <TimeSeries title="Air temperature" unit="°C" color={SERIES.temp} points={series.temp} spanHours={hours} />
                <TimeSeries title="Humidity" unit="%" color={SERIES.humidity} points={series.humidity} spanHours={hours} />
                <TimeSeries title="Light" unit="lux" color={SERIES.light} points={series.light} spanHours={hours} decimals={0} />
            </div>

            {showTable ? (
                <div className="card" style={{ marginTop: 12 }}>
                    <div className="tile-label">All readings in this range</div>
                    <div className="table-scroll">
                        <table>
                            <thead>
                                <tr>
                                    <th>Time</th>
                                    <th>Soil %</th>
                                    <th>Soil raw</th>
                                    <th>Temp °C</th>
                                    <th>Humidity %</th>
                                    <th>Light lux</th>
                                    <th>hPa</th>
                                    <th>dBm</th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...readings].reverse().map((r) => (
                                    <tr key={r.recorded_at}>
                                        <td>
                                            {new Date(r.recorded_at).toLocaleString([], {
                                                day: 'numeric',
                                                month: 'short',
                                                hour: '2-digit',
                                                minute: '2-digit',
                                            })}
                                        </td>
                                        <td>{r.soil_pct ?? '—'}</td>
                                        <td>{r.soil_raw ?? '—'}</td>
                                        <td>{r.air_temp_c?.toFixed(1) ?? '—'}</td>
                                        <td>{r.humidity_pct?.toFixed(1) ?? '—'}</td>
                                        <td>{r.lux?.toFixed(0) ?? '—'}</td>
                                        <td>{r.pressure_hpa?.toFixed(0) ?? '—'}</td>
                                        <td>{r.rssi ?? '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
