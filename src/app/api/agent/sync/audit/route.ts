import { and, eq, gte, lte, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { withAgent } from "@/lib/agent-auth/route";
import { assertPcucodeMatches } from "@/lib/agent-auth/verify";
import { db } from "@/lib/db";
import { drugUsage } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const schema = z.object({
  pcucode: z.string().min(1).max(5),
  from: isoDate,
  to: isoDate,
});

/**
 * POST /api/agent/sync/audit
 *
 * Returns how many rows the central database holds per month for this
 * facility. The agent compares it with the same tally taken from JHCIS and
 * re-sends only the months that differ.
 *
 * This is what makes the pipeline self-healing: a run interrupted by a dead
 * link, a restarted PC or a half-applied migration leaves a hole that nobody
 * would otherwise notice, because every individual batch reported success for
 * the parts it did deliver.
 */
export const POST = withAgent(schema, async ({ agent, body }) => {
  assertPcucodeMatches(agent, body.pcucode);

  const month = sql<string>`DATE_FORMAT(${drugUsage.usageDate}, '%Y-%m')`.as("month");

  const rows = await db
    .select({ month, rows: sql<number>`COUNT(*)` })
    .from(drugUsage)
    .where(
      and(
        eq(drugUsage.facilityId, agent.facilityId),
        gte(drugUsage.usageDate, body.from),
        lte(drugUsage.usageDate, body.to),
      ),
    )
    .groupBy(sql`month`)
    .orderBy(sql`month asc`);

  return NextResponse.json({
    facilityId: agent.facilityId,
    from: body.from,
    to: body.to,
    months: rows.map((row) => ({ month: String(row.month), rows: Number(row.rows) })),
  });
});
