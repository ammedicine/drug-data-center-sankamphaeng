export function percentOfTotal(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  const percentage = Math.round((value / total) * 1_000) / 10;
  return Math.min(100, Math.max(0, percentage));
}
