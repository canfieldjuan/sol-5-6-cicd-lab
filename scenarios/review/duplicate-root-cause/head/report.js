export function normalizeReport(report) {
  const minutes = Number(report.minutes || 0);
  return {
    summaryMinutes: minutes,
    tableMinutes: minutes
  };
}
