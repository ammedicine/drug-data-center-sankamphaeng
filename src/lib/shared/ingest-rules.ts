/**
 * Which source rows the central database is able to store.
 *
 * JHCIS contains a small number of dispensing rows that can never become a
 * usage record: the reference database has one with an empty drugcode. The
 * server rejects them on purpose and records the reason, and that is correct -
 * but it means the row exists at the source and will never exist at the
 * centre, and anything comparing the two by count has to know that.
 *
 * It did not. Reconciliation compared JHCIS's row count for a month against
 * the rows the centre had accepted, so February 2024 read as 2 against 1 for
 * ever: every scheduled run re-read the month, re-uploaded it, had the same
 * row refused again, decided the month was still short, and repaired it - an
 * hourly loop that also pinned the agent's watermark to February 2024 and
 * stopped it ever reaching the present.
 *
 * The rule lives here, once, in the two forms it is needed in: a SQL fragment
 * for counting at the source, and a predicate for validating a record at the
 * centre. They are deliberately adjacent so that changing one without the
 * other is obvious, and a test asserts they agree.
 *
 * Only conditions that are a permanent property of the source row belong
 * here. A row refused for any other reason must still show up as a gap - that
 * is a surprise, and a surprise is exactly what reconciliation is for.
 */

/** The identity fields a usage record is keyed by, as read from JHCIS. */
export interface SourceRowIdentity {
  drugCode: string | null | undefined;
  visitNo: number | null | undefined;
}

/**
 * True when the centre can never store this row, however many times it is
 * sent. Keep in step with INELIGIBLE_SOURCE_ROW_SQL below.
 */
export function isIneligibleSourceRow(row: SourceRowIdentity): boolean {
  if (!String(row.drugCode ?? "").trim()) return true;
  const visitNo = Number(row.visitNo);
  if (!Number.isInteger(visitNo) || visitNo <= 0) return true;
  return false;
}

/**
 * The same rule as a SQL predicate over `visitdrug vd`, for counting at the
 * source without reading the rows. Keep in step with isIneligibleSourceRow.
 *
 * MySQL 5.6 on the รพ.สต. side, so nothing newer than TRIM and IS NULL.
 */
export const INELIGIBLE_SOURCE_ROW_SQL =
  "(vd.drugcode IS NULL OR TRIM(vd.drugcode) = '' OR vd.visitno IS NULL OR vd.visitno <= 0)";

/** Rows the centre is expected to be able to store: the complement of the above. */
export const ELIGIBLE_SOURCE_ROW_SQL = `NOT ${INELIGIBLE_SOURCE_ROW_SQL}`;
