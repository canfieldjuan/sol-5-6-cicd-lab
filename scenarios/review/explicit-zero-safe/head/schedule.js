export function scheduleLabel(day) {
  if (!Number.isFinite(day.scheduledMinutes)) return "-";
  return `${day.scheduledMinutes} min`;
}
