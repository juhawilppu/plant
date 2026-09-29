// The exact time a chart point stands for, as the readouts under the pointer
// say it. Always with the date and the year: a readout is where the reader goes
// to find out precisely when something happened, so it never leaves the day to
// be worked out from the axis.

const DATE = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
const TIME = { hour: '2-digit', minute: '2-digit' };

// One reading: the moment it was taken, to the second.
export function exactTime(iso) {
    return new Date(iso).toLocaleString([], { ...DATE, ...TIME, second: '2-digit' });
}

// One bucket of the long view: an average is not a moment, so the readout gives
// the stretch of time it averages over, start to end, in the reader's own zone.
// The buckets are cut on UTC boundaries (see /api/history), so a "daily" one
// here runs from, say, 03:00 to 03:00 and says so rather than claiming a
// calendar day it does not cover.
export function bucketSpan(iso, bucketSeconds) {
    const start = Date.parse(iso);
    return rangeText(start, start + bucketSeconds * 1000);
}

// Any stretch of time, to the minute, with the date said once when both ends
// fall on the same day.
export function rangeText(fromMs, toMs) {
    const start = new Date(fromMs);
    const end = new Date(toMs);
    const from = start.toLocaleString([], { ...DATE, ...TIME });
    if (start.toDateString() === end.toDateString()) {
        return `${from}–${end.toLocaleTimeString([], TIME)}`;
    }
    return `${from} – ${end.toLocaleString([], { ...DATE, ...TIME })}`;
}
