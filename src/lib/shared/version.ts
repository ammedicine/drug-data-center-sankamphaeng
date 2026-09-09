/**
 * Comparing agent versions.
 *
 * String comparison is wrong in a way that only shows up later: "1.1.10" sorts
 * below "1.1.9", so the fleet would stop updating at the ninth patch and no
 * one would notice until a release simply failed to roll out. Compared by
 * number, per part, always.
 *
 * A build only ever moves forward. Offering an older version to a machine that
 * already has a newer one - after a release is pulled, say - would have every
 * PC in the district quietly install a downgrade, so equal and older both mean
 * "do nothing".
 */

/** Accepts "1.2.3" or "v1.2.3"; anything else is not a version we know. */
export function parseVersion(raw: string | null | undefined): number[] | null {
  const text = String(raw ?? "").trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+){0,3}$/.test(text)) return null;
  return text.split(".").map((part) => Number(part));
}

/** -1, 0 or 1, or null when either side is not a version. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** True only when `candidate` is strictly newer than `installed`. */
export function isNewerVersion(candidate: string | null | undefined, installed: string | null | undefined): boolean {
  return compareVersions(candidate, installed) === 1;
}
