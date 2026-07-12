/** Display-time helpers — internal storage stays UTC; user-facing text uses UTC+8. */

const DISPLAY_OFFSET_MS = 8 * 60 * 60 * 1000;

export function formatDisplayTime(date = new Date(), fmt: "full" | "hm" = "full"): string {
  const utc8 = new Date(date.getTime() + DISPLAY_OFFSET_MS);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc8.getUTCDate()).padStart(2, "0");
  const h = String(utc8.getUTCHours()).padStart(2, "0");
  const min = String(utc8.getUTCMinutes()).padStart(2, "0");
  if (fmt === "hm") return `${h}:${min} UTC+8`;
  return `${y}-${m}-${d} ${h}:${min} UTC+8`;
}

export function formatDisplayShortTime(date: Date): string {
  const utc8 = new Date(date.getTime() + DISPLAY_OFFSET_MS);
  const m = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc8.getUTCDate()).padStart(2, "0");
  const h = String(utc8.getUTCHours()).padStart(2, "0");
  const min = String(utc8.getUTCMinutes()).padStart(2, "0");
  return `${m}-${d} ${h}:${min} UTC+8`;
}

export function todayDisplayDate(): string {
  const utc8 = new Date(Date.now() + DISPLAY_OFFSET_MS);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc8.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function nowHm(): string {
  return formatDisplayTime(new Date(), "hm");
}
