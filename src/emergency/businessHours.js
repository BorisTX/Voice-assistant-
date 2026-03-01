import { DateTime } from "luxon";

function parseTimeToMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return hours * 60 + minutes;
}

function getProfileHours(profile = {}) {
  const explicitStart = profile.working_hours_start || profile.workingHoursStart;
  const explicitEnd = profile.working_hours_end || profile.workingHoursEnd;

  if (explicitStart && explicitEnd) {
    return { start: explicitStart, end: explicitEnd };
  }

  const raw = profile.working_hours_json;
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const weekdays = ["mon", "tue", "wed", "thu", "fri"];
    for (const day of weekdays) {
      const windows = Array.isArray(parsed?.[day]) ? parsed[day] : [];
      if (windows.length > 0 && windows[0]?.start && windows[windows.length - 1]?.end) {
        return { start: windows[0].start, end: windows[windows.length - 1].end };
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function isOutsideBusinessHours({ startUtc, businessProfile }) {
  if (!startUtc) return false;

  const timezone = businessProfile?.timezone || "UTC";
  const localStart = DateTime.fromISO(startUtc, { zone: "utc" }).setZone(timezone);
  if (!localStart.isValid) return false;

  const hours = getProfileHours(businessProfile);
  if (!hours) return false;

  const startMinutes = parseTimeToMinutes(hours.start);
  const endMinutes = parseTimeToMinutes(hours.end);
  if (startMinutes == null || endMinutes == null) return false;

  const currentMinutes = localStart.hour * 60 + localStart.minute;

  if (startMinutes === endMinutes) return false;

  if (startMinutes < endMinutes) {
    return currentMinutes < startMinutes || currentMinutes >= endMinutes;
  }

  return currentMinutes >= endMinutes && currentMinutes < startMinutes;
}
