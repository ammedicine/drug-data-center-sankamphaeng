"use client";

import { useRouter } from "next/navigation";

import { LiveRefresh } from "./live-status";

/**
 * Drop-in for a server component: polls, and refreshes the page on real news.
 *
 * `initialSignature` is what the page around it is showing, so the very first
 * poll can tell whether that is still true.
 */
export function LiveStatusBadge({ initialSignature }: { initialSignature?: string | null }) {
  const router = useRouter();
  return <LiveRefresh router={router} initialSignature={initialSignature} />;
}
