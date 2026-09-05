/**
 * Cache layer for the reporting queries.
 *
 * The reports read a table that only changes when an agent delivers a sync
 * batch - between deliveries every visitor recomputes the same aggregate over
 * the same 265k rows, which is what made moving between pages feel slow. The
 * results are cached and dropped the moment new usage rows land, so a page is
 * only ever recomputed when the answer has actually changed.
 *
 * The cache key is built from the exact values that go into the SQL WHERE
 * clause - facility scope included - so two sessions can only share an entry
 * when they asked for identically scoped data. Facility isolation still comes
 * from resolveFacilityScope() upstream; this never widens it.
 */
import { revalidateTag, unstable_cache } from "next/cache";

/** Everything derived from drug_usage hangs off this one tag. */
export const USAGE_TAG = "drug-usage";

/** Long enough to make navigation instant, short enough to stay honest. */
const TTL_SECONDS = 300;

/**
 * Wraps a reporting function so identical arguments are answered from cache.
 *
 * `name` must be unique per function: it is part of the key, and two functions
 * sharing a name would read each other's results.
 */
export function cachedReport<Args extends unknown[], Result>(
  name: string,
  fn: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args: Args) =>
    unstable_cache(() => fn(...args), [name, JSON.stringify(args)], {
      tags: [USAGE_TAG],
      revalidate: TTL_SECONDS,
    })();
}

/**
 * Called after usage rows are written. Every cached report is dropped, so the
 * next page load reflects the sync that just landed rather than waiting out
 * the TTL.
 */
export function invalidateUsageReports(): void {
  try {
    revalidateTag(USAGE_TAG);
  } catch {
    // revalidateTag is only callable inside a request or action scope. The
    // agent upload route is one, but a background caller may not be, and a
    // failure to clear the cache must never fail the ingest that just
    // succeeded - the TTL will catch up.
  }
}
