export function parseCron(expression) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}": expected 5 fields, got ${parts.length}`);
  }
  return {
    minutes: parseCronField(parts[0] ?? "", 0, 59),
    hours: parseCronField(parts[1] ?? "", 0, 23),
    daysOfMonth: parseCronField(parts[2] ?? "", 1, 31),
    months: parseCronField(parts[3] ?? "", 1, 12),
    daysOfWeek: parseCronField(parts[4] ?? "", 0, 6),
  };
}
export function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    if (!part) throw new Error("Invalid empty cron field part");
    addCronPart(values, part, min, max);
  }
  return values;
}
function addCronPart(values, part, min, max) {
  const [rangePart = "", stepPart] = part.split("/");
  const step = stepPart == null ? 1 : Number.parseInt(stepPart, 10);
  if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid step in cron field: "${part}"`);
  let start = min;
  let end = max;
  if (rangePart !== "*") {
    if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = parseCronNumber(rawStart, min, max, part);
      end = parseCronNumber(rawEnd, min, max, part);
      if (start > end) throw new Error(`Invalid range in cron field: "${part}"`);
    } else {
      start = parseCronNumber(rangePart, min, max, part);
      end = stepPart == null ? start : max;
    }
  }
  for (let value = start; value <= end; value += step) {
    if (value < min || value > max)
      throw new Error(`Invalid value in cron field: "${part}" (valid range: ${min}-${max})`);
    values.add(value);
  }
}
function parseCronNumber(value, min, max, part) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid value in cron field: "${part}" (valid range: ${min}-${max})`);
  }
  return parsed;
}
export function matchesCron(schedule, date) {
  return (
    schedule.minutes.has(date.getMinutes()) &&
    schedule.hours.has(date.getHours()) &&
    schedule.daysOfMonth.has(date.getDate()) &&
    schedule.months.has(date.getMonth() + 1) &&
    schedule.daysOfWeek.has(date.getDay())
  );
}
export function cronMatches(expression, date = new Date()) {
  return matchesCron(parseCron(expression), date);
}
