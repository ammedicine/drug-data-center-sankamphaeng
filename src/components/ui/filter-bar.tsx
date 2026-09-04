import clsx from "clsx";
import Link from "next/link";
import { RotateCcw, Search } from "lucide-react";
import type { ReactNode } from "react";

import { Button, buttonClass } from "./primitives";

/**
 * The query toolbar used above reports.
 *
 * It is a plain GET form - the URL stays shareable and the back button keeps
 * working - presented as a toolbar rather than a card, so it reads as a control
 * strip attached to the results below it rather than as its own panel.
 */
export function FilterBar({
  children,
  resetHref,
  submitLabel = "ค้นหา",
  note,
  className,
  hiddenFields,
}: {
  children: ReactNode;
  resetHref: string;
  submitLabel?: string;
  note?: ReactNode;
  className?: string;
  hiddenFields?: Record<string, string | undefined>;
}) {
  return (
    <form
      method="get"
      className={clsx(
        "rounded-[10px] border border-line bg-surface px-4 py-3.5 no-print",
        className,
      )}
    >
      {Object.entries(hiddenFields ?? {}).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}

      <div className="flex flex-wrap items-end gap-3">{children}</div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        <Button type="submit" size="sm" icon={Search}>
          {submitLabel}
        </Button>
        <Link href={resetHref} className={buttonClass("ghost", "sm")}>
          <RotateCcw aria-hidden className="size-4" />
          ค่าเริ่มต้น
        </Link>
        {note ? <span className="ml-auto text-xs text-muted">{note}</span> : null}
      </div>
    </form>
  );
}

/** A labelled control inside the toolbar, sized to its content. */
export function FilterField({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx("block min-w-[150px]", className)}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

/**
 * Checkbox rendered as a chip. The native input stays in place - it is what the
 * form submits and what a screen reader and the keyboard operate - and the chip
 * is only its visible skin.
 */
export function FilterChip({
  name,
  value,
  label,
  suffix,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: string;
  suffix?: string;
  defaultChecked?: boolean;
}) {
  return (
    <label
      className={clsx(
        "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] transition-colors duration-150",
        "has-[:checked]:border-brand-line has-[:checked]:bg-brand-soft has-[:checked]:text-brand-ink",
        "border-line text-ink-soft hover:bg-raised",
      )}
    >
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="size-3.5 accent-[color:var(--color-brand)]"
      />
      {label}
      {suffix ? <span className="text-[11px] text-muted">{suffix}</span> : null}
    </label>
  );
}
