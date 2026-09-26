import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// The live page's data: a snapshot of the last `hours` fetched over HTTP, with
// readings pushed over the /api/live WebSocket appended as they land.
//
// The snapshot is the source of truth and the socket only ever adds to it. So a
// reconnect re-fetches the snapshot, because whatever arrived while the socket
// was down exists only in the database. And while the socket is down, the page
// polls instead, so a proxy that refuses WebSockets costs freshness, not data.
//
// The server sends a heartbeat every 30 s. Hearing nothing for well over that
// means the socket died without closing - the usual state of one that was open
// when a laptop went to sleep - so it is dropped and replaced.
const HEARTBEAT_TIMEOUT_MS = 75 * 1000;
const POLL_WHILE_DOWN_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 1000;

// The header counts the seconds since the last reading, and a reading's
// timestamp comes from the server's clock, so the count has to run on it too.
// The snapshot, the socket's hello and every heartbeat say what time the
// server makes it. Each sample is late by however long it took to arrive,
// which only ever makes the offset read low, so the best recent sample is the
// highest: a slow 48-hour snapshot cannot drag the count a second off.
const CLOCK_SAMPLES = 10;

export default function useLive(device, hours) {
    const [snapshot, setSnapshot] = useState(null);
    const [devices, setDevices] = useState([]);
    const [pushed, setPushed] = useState([]);
    const [error, setError] = useState(null);
    const [live, setLive] = useState(false);
    const [reload, setReload] = useState(0);
    const [clockOffset, setClockOffset] = useState(0);
    const clockSamples = useRef([]);

    // Server time minus browser time, in milliseconds.
    const sampleClock = useCallback((serverNow) => {
        const sample = Date.parse(serverNow) - Date.now();
        if (Number.isNaN(sample)) return;
        clockSamples.current = [...clockSamples.current, sample].slice(-CLOCK_SAMPLES);
        setClockOffset(Math.max(...clockSamples.current));
    }, []);

    useEffect(() => {
        let cancelled = false;
        const json = (r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        };
        Promise.all([
            fetch(`/api/readings?device=${encodeURIComponent(device)}&hours=${hours}`).then(json),
            fetch('/api/devices').then(json),
        ])
            .then(([snap, devs]) => {
                if (cancelled) return;
                if (snap.now) sampleClock(snap.now);
                setSnapshot(snap);
                setDevices(devs);
                setError(null);
            })
            .catch((e) => !cancelled && setError(e.message));
        return () => {
            cancelled = true;
        };
    }, [device, hours, reload, sampleClock]);

    useEffect(() => {
        if (live) return;
        const id = setInterval(() => setReload((n) => n + 1), POLL_WHILE_DOWN_MS);
        return () => clearInterval(id);
    }, [live]);

    useEffect(() => {
        const { protocol, host } = window.location;
        const url = `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/api/live`;
        let ws = null;
        let watchdog = null;
        let retry = null;
        let attempt = 0;
        let opened = false;
        let stopped = false;

        const arm = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(drop, HEARTBEAT_TIMEOUT_MS);
        };

        // Abandon the current socket and schedule a fresh one. The handlers come
        // off first: a dead socket's close event can take a long time to arrive,
        // and when it does it must not schedule a second reconnect.
        function drop() {
            clearTimeout(watchdog);
            if (ws) {
                ws.onopen = ws.onmessage = ws.onclose = null;
                ws.close();
                ws = null;
            }
            setLive(false);
            if (stopped) return;
            // Exponential backoff with jitter, so a server restart is not met by
            // every open tab reconnecting in the same instant.
            const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
            attempt++;
            retry = setTimeout(connect, delay);
        }

        function connect() {
            ws = new WebSocket(url);
            ws.onopen = () => {
                attempt = 0;
                setLive(true);
                arm();
                // The first open needs no re-fetch: the snapshot is already on its
                // way, and the latest reading the server sends on connect covers
                // the moment between the two.
                if (opened) setReload((n) => n + 1);
                opened = true;
            };
            ws.onmessage = (event) => {
                arm();
                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return;
                }
                if (msg.now) sampleClock(msg.now);
                if (msg.type !== 'reading' || msg.device !== device) return;
                const reading = msg.reading;
                setPushed((prev) => {
                    // The on-connect replay can repeat a reading already here.
                    const last = prev[prev.length - 1];
                    if (last && reading.recorded_at <= last.recorded_at) return prev;
                    const cutoff = Date.now() - hours * 3600 * 1000;
                    return [...prev.filter((r) => Date.parse(r.recorded_at) > cutoff), reading];
                });
            };
            // An error event is always followed by a close, so close covers both.
            ws.onclose = drop;
        }

        connect();
        return () => {
            stopped = true;
            clearTimeout(retry);
            drop();
        };
    }, [device, hours, sampleClock]);

    // The snapshot plus whatever the socket delivered after its last reading,
    // with anything that has aged out of the window dropped. Nothing re-fetches
    // the snapshot while the socket is healthy, so this is also what keeps the
    // window sliding forward as readings arrive.
    const data = useMemo(() => {
        if (!snapshot) return null;
        const last = snapshot.readings[snapshot.readings.length - 1]?.recorded_at ?? '';
        const newer = pushed.filter((r) => r.recorded_at > last);
        const cutoff = Date.now() - hours * 3600 * 1000;
        const readings = [...snapshot.readings, ...newer].filter(
            (r) => Date.parse(r.recorded_at) > cutoff,
        );
        return { ...snapshot, readings };
    }, [snapshot, pushed, hours]);

    return { data, devices, error, live, clockOffset };
}
