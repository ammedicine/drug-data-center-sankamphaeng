"use client";

import { useRouter } from "next/navigation";

import { LiveRefresh } from "./live-status";

/** Drop-in for a server component: polls, and refreshes the page on real news. */
export function LiveStatusBadge() {
  const router = useRouter();
  return <LiveRefresh router={router} />;
}
