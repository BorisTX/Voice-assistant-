// src/slots.js
import { DateTime } from "luxon";

// Our working_hours_json keys
// We'll use keys: sun, mon, tue, wed, thu, fri, sat
const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function safeJsonParse(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

function parseHHMM(hhmm) {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw new Error(`Bad time: ${hhmm}`);
  return { h, m };
}

function makeZonedDateTime(dateZ, hhmm) {
  const { h, m } = parseHHMM(hhmm);
  return dateZ.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

// Align up to grid (granularity minutes) in the same zone
function alignUp(dt, granMin) {
  const minutes = dt.hour * 60 + dt.minute;
  const aligned = Math.ceil(minutes / granMin) * granMin;
  const hour = Math.floor(aligned / 60);
  const minute = aligned % 60;
  return dt.set({ hour, minute, second: 0, millisecond: 0 });
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  // strict overlap
  return aStart < bEnd && aEnd > bStart;
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = intervals
    .slice()
    .sort((x, y) => x.start.toMillis() - y.start.toMillis());

  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start.toMillis() <= last.end.toMillis()) {
      last.end = DateTime.max(last.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/**
 * Expand busy intervals by buffers (in minutes) and merge overlaps.
 * busy: [{startUtcIso, endUtcIso}] or [{start, end}] where values are ISO strings
 *
 * NOTE: freebusy returns UTC ISO strings in { start, end } already, so this works.
 */
export function normalizeBusyUtc(busy, bufferBeforeMin = 0, bufferAfterMin = 0) {
  const intervals = (busy || [])
    .map((b) => {
      const s = DateTime.fromISO(b.startUtcIso || b.start, { zone: "utc" });
      const e = DateTime.fromISO(b.endUtcIso || b.end, { zone: "utc" });
      if (!s.isValid || !e.isValid) return null;

      return {
        start: s.minus({ minutes: Number(bufferBeforeMin) || 0 }),
        end: e.plus({ minutes: Number(bufferAfterMin) || 0 }),
      };
    })
    .filter(Boolean);

  return mergeIntervals(intervals);
}

/**
 * Generate available slots for a business, deterministically.
 *
 * business: row from DB (needs timezone, working_hours_json, default_duration_min, slot_granularity_min, lead_time_min)
 * windowStartDate: DateTime in business TZ at start of day
 * days: integer days ahead
 * durationMin: appointment duration
 * busyMergedUtc: output of normalizeBusyUtc()
 */
export function generateSlots({
  business,
  windowStartDate,
  days,
  durationMin,
  busyMergedUtc,
}) {
  const tz = business.timezone || "America/Chicago";

  const working = safeJsonParse(business.working_hours_json, {});
  const granMin = Number(business.slot_granularity_min || 15);
  const durMin = Number(durationMin || business.default_duration_min || 60);
  const leadMin = Number(business.lead_time_min || 0);

  const nowZ = DateTime.now().setZone(tz);
  const earliestZ = nowZ.plus({ minutes: leadMin });

  const out = [];
  const startDayZ = windowStartDate.setZone(tz).startOf("day");
  const endDateZ = startDayZ.plus({ days: Number(days) || 0 });

  // iterate days [startDayZ, endDateZ)
  for (let d = startDayZ; d < endDateZ; d = d.plus({ days: 1 })) {
    // Luxon weekday: 1=Mon..7=Sun. Convert to our WD index: 0=Sun..6=Sat.
    const wdIndex = d.weekday === 7 ? 0 : d.weekday; // Mon->1..Sat->6, Sun->0
    const wdKey = WD[wdIndex]; // "sun".."sat"

    const dayWindows = Array.isArray(working[wdKey]) ? working[wdKey] : [];
    if (!dayWindows.length) continue;

    for (const w of dayWindows) {
      // Expect w = { start: "HH:MM", end: "HH:MM" }
      let startZ, endZ;
      try {
        startZ = makeZonedDateTime(d, w.start);
        endZ = makeZonedDateTime(d, w.end);
      } catch {
        // skip malformed windows
        continue;
      }

      if (endZ <= startZ) continue;

      // slots start not earlier than lead time
      let cursorZ = DateTime.max(startZ, earliestZ);
      cursorZ = alignUp(cursorZ, granMin);

      while (cursorZ.plus({ minutes: durMin }) <= endZ) {
        const slotStartZ = cursorZ;
        const slotEndZ = cursorZ.plus({ minutes: durMin });

        const slotStartUtc = slotStartZ.toUTC();
        const slotEndUtc = slotEndZ.toUTC();

        // check overlap with merged busy intervals
        let blocked = false;
        for (const b of busyMergedUtc || []) {
          if (overlaps(slotStartUtc, slotEndUtc, b.start, b.end)) {
            blocked = true;
            break;
          }
        }

        if (!blocked) {
          out.push({
            start_local: slotStartZ.toISO(),
            end_local: slotEndZ.toISO(),
            start_utc: slotStartUtc.toISO(),
            end_utc: slotEndUtc.toISO(),
          });
        }

        cursorZ = cursorZ.plus({ minutes: granMin });
      }
    }
  }

  return out;
}
