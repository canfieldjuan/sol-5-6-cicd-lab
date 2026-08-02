export function scheduleLabel(day) {
  return `${Number(day.scheduledMinutes || 0)} min`;
}
