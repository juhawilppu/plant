// ClickHouse over its HTTP interface, for cdc.js (writes) and the history
// endpoint (reads). Plain fetch rather than a client library: two kinds of
// call, and one less dependency in a process that has to fit in 160 MB.

const URL_BASE = process.env.CLICKHOUSE_URL || 'http://localhost:58123';
const USER = process.env.CLICKHOUSE_USER || 'plant';
const PASSWORD = process.env.CLICKHOUSE_PASSWORD || '';
const DATABASE = process.env.CLICKHOUSE_DB || 'plant_vitals';

// `params` become ClickHouse query parameters ({name:Type} in the query), so
// values never get spliced into SQL. `body` is data for an insert; without
// it the query itself goes in the body.
export async function clickhouse(query, { body, params = {}, timeoutMs = 30_000 } = {}) {
    const url = new URL(URL_BASE);
    url.searchParams.set('database', DATABASE);
    // Reads the ISO strings Date.toJSON() writes, 'Z' and all, and writes
    // them back the same way, so a time crosses in both directions as UTC.
    url.searchParams.set('date_time_input_format', 'best_effort');
    url.searchParams.set('date_time_output_format', 'iso');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, String(v));
    if (body !== undefined) url.searchParams.set('query', query);

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'X-ClickHouse-User': USER, 'X-ClickHouse-Key': PASSWORD },
        body: body ?? query,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.trim().slice(0, 300)}`);
    return text;
}

// A select, one object per row.
export async function clickhouseRows(query, options) {
    const text = await clickhouse(`${query} format JSONEachRow`, options);
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
