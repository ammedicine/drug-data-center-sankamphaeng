/**
 * Shared presentational primitives (PROJECT_SPEC section 19).
 *
 * These carry the whole visual system: pages compose them and should not need
 * their own long class strings. Everything here is server-compatible - no
 * hooks, no client-only APIs - so pages stay server components.
 */
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ layout */

/**
 * Page heading zone.
 *
 * No border underneath by default: spacing and weight carry the hierarchy, and
 * a rule under every title makes a dense screen look like a stack of receipts.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="mb-6">
      {breadcrumb ? <div className="mb-2 text-[13px] text-muted">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink sm:text-[26px]">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-muted">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div> : null}
      </div>
    </header>
  );
}

/**
 * A grouped panel. `flush` removes the inner padding for tables and charts that
 * manage their own edges.
 */
export function Card({
  children,
  className,
  title,
  description,
  actions,
  footer,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  description?: string;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section
      className={clsx("rounded-[10px] border border-line bg-surface", className)}
    >
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-snug text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
      {footer ? (
        <div className="border-t border-hairline px-5 py-3 text-[13px] text-muted">{footer}</div>
      ) : null}
    </section>
  );
}

/** Padding for content placed directly inside a Card. */
export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={clsx("p-5", className)}>{children}</div>;
}

/** A titled block that is part of the page rather than a floating panel. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("mt-8", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2 no-print">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/* --------------------------------------------------------------------- KPI */

/**
 * A single figure with its label and unit.
 *
 * `tone` tints only the value, never the whole tile: an operational warning
 * should catch the eye without turning the row into a traffic light. `accent`
 * marks the one tile on a page that is about system state rather than data.
 */
export function StatCard({
  label,
  value,
  unit,
  hint,
  tone = "default",
  icon: Icon,
  accent = false,
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "danger";
  icon?: LucideIcon;
  accent?: boolean;
}) {
  const toneClass = {
    default: "text-ink",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
  }[tone];

  return (
    <div
      className={clsx(
        "rounded-[10px] border border-line bg-surface px-4 py-3.5",
        accent && "border-l-[3px] border-l-brand",
      )}
    >
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon aria-hidden className="size-[15px] shrink-0 text-muted" /> : null}
        <p className="text-[13px] font-medium text-muted">{label}</p>
      </div>
      <p className={clsx("mt-1.5 text-[26px] font-semibold leading-none numeric", toneClass)}>
        {typeof value === "number" ? value.toLocaleString("th-TH") : value}
        {unit ? <span className="ml-1.5 text-[13px] font-normal text-muted">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-2 text-xs leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ status */

const STATUS_STYLES: Record<string, string> = {
  ONLINE: "bg-ok-soft text-ok",
  SYNCING: "bg-info-soft text-info",
  OFFLINE: "bg-raised text-muted",
  ERROR: "bg-danger-soft text-danger",
  DISABLED: "bg-raised text-muted",
  COMPLETED: "bg-ok-soft text-ok",
  STARTED: "bg-info-soft text-info",
  UPLOADING: "bg-info-soft text-info",
  FAILED: "bg-danger-soft text-danger",
  ABORTED: "bg-warn-soft text-warn",
  ACTIVE: "bg-ok-soft text-ok",
  INACTIVE: "bg-warn-soft text-warn",
  UNKNOWN: "bg-raised text-muted",
  PENDING: "bg-warn-soft text-warn",
};

const STATUS_LABELS: Record<string, string> = {
  ONLINE: "ออนไลน์",
  SYNCING: "กำลังซิงก์",
  OFFLINE: "ออฟไลน์",
  ERROR: "ผิดพลาด",
  DISABLED: "ปิดใช้งาน",
  COMPLETED: "สำเร็จ",
  STARTED: "เริ่มแล้ว",
  UPLOADING: "กำลังอัปโหลด",
  FAILED: "ล้มเหลว",
  ABORTED: "ยกเลิก",
  ACTIVE: "ใช้งาน",
  INACTIVE: "ปิดใช้งาน",
  UNKNOWN: "ไม่ทราบสถานะ",
  PENDING: "รออนุมัติ",
};

/**
 * Operational status. The dot repeats the state as a shape so it does not rely
 * on colour alone, and the label is always spelled out.
 */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STATUS_STYLES[status] ?? "bg-raised text-muted",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/* ------------------------------------------------------------------ states */

export function EmptyState({
  title,
  description,
  action,
  icon: Icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-14 text-center">
      {Icon ? <Icon aria-hidden className="mb-1 size-5 text-muted/70" /> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? <p className="max-w-md text-[13px] text-muted">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="alert" className="rounded-[10px] border border-danger/25 bg-danger-soft px-4 py-3">
      <p className="text-sm font-medium text-danger">{title}</p>
      {detail ? <p className="mt-1 text-[13px] text-danger/85">{detail}</p> : null}
    </div>
  );
}

export function LoadingState({ label = "กำลังโหลดข้อมูล..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 px-6 py-14 text-[13px] text-muted">
      <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-brand" />
      {label}
    </div>
  );
}

/** Inline notice used inside forms and panels. */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "ok" | "warn" | "danger";
  children: ReactNode;
}) {
  const styles = {
    info: "bg-info-soft text-info",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
  }[tone];
  return (
    <p role="status" className={clsx("rounded-[6px] px-3 py-2 text-[13px]", styles)}>
      {children}
    </p>
  );
}

/* ----------------------------------------------------------------- controls */

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55";

const BUTTON_VARIANTS = {
  primary: "bg-brand text-white hover:bg-brand-hover",
  secondary: "border border-line bg-surface text-ink hover:bg-raised",
  ghost: "text-ink-soft hover:bg-raised hover:text-ink",
  danger: "border border-danger/30 bg-surface text-danger hover:bg-danger-soft",
} as const;

const BUTTON_SIZES = {
  sm: "h-8 px-2.5 text-[13px]",
  md: "h-10 px-4 text-sm",
} as const;

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  type = "button",
  icon: Icon,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  icon?: LucideIcon;
}) {
  return (
    <button
      type={type}
      className={clsx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...rest}
    >
      {Icon ? <Icon aria-hidden className="size-4 shrink-0" /> : null}
      {children}
    </button>
  );
}

/** A link styled as a button, for navigation that looks like an action. */
export const buttonClass = (
  variant: keyof typeof BUTTON_VARIANTS = "secondary",
  size: keyof typeof BUTTON_SIZES = "md",
) => clsx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size]);

export function Field({
  label,
  children,
  hint,
  error,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
  htmlFor?: string;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
      {error ? (
        <span className="mt-1 block text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

/**
 * One appearance for every text input, select and date field: 40px tall, a
 * neutral border that only gains colour on focus, and a native select arrow
 * left alone rather than replaced by a hand-rolled dropdown.
 */
export const inputClass =
  "h-10 w-full rounded-[6px] border border-line bg-surface px-3 text-sm text-ink transition-colors duration-150 placeholder:text-muted/70 hover:border-muted/50 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted";

/** Same look for a multi-line control. */
export const textareaClass = `${inputClass} h-auto min-h-24 py-2 leading-relaxed`;

/* ---------------------------------------------------------------- formatting */

export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("th-TH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("th-TH", { dateStyle: "medium" });
}

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return "ไม่เคย";
  const date = typeof value === "string" ? new Date(value) : value;
  const diffMinutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (diffMinutes < 1) return "เมื่อสักครู่";
  if (diffMinutes < 60) return `${diffMinutes} นาทีที่แล้ว`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours} ชั่วโมงที่แล้ว`;
  return `${Math.round(hours / 24)} วันที่แล้ว`;
}
