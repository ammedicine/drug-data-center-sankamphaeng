/**
 * Shared presentational primitives (PROJECT_SPEC section 19).
 * Server-compatible: no hooks, no client-only APIs.
 */
import clsx from "clsx";
import type { ReactNode } from "react";

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
    <header className="mb-6 border-b border-line pb-5">
      {breadcrumb ? <div className="mb-2 text-xs text-muted">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
          {subtitle ? <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2 no-print">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Card({
  children,
  className,
  title,
  description,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <section
      className={clsx(
        "rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(16,32,46,0.04)]",
        className,
      )}
    >
      {title ? (
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  unit,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "danger";
}) {
  const toneClass = {
    default: "text-ink",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
  }[tone];

  return (
    <div className="rounded-xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(16,32,46,0.04)]">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={clsx("mt-2 text-2xl font-semibold numeric", toneClass)}>
        {typeof value === "number" ? value.toLocaleString("th-TH") : value}
        {unit ? <span className="ml-1 text-sm font-normal text-muted">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  ONLINE: "bg-ok-bg text-ok",
  SYNCING: "bg-info-bg text-info",
  OFFLINE: "bg-[#eef1f4] text-muted",
  ERROR: "bg-danger-bg text-danger",
  DISABLED: "bg-[#eef1f4] text-muted",
  COMPLETED: "bg-ok-bg text-ok",
  STARTED: "bg-info-bg text-info",
  UPLOADING: "bg-info-bg text-info",
  FAILED: "bg-danger-bg text-danger",
  ABORTED: "bg-warn-bg text-warn",
  ACTIVE: "bg-ok-bg text-ok",
  INACTIVE: "bg-[#eef1f4] text-muted",
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
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        STATUS_STYLES[status] ?? "bg-[#eef1f4] text-muted",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[color:var(--color-danger)]/25 bg-danger-bg px-5 py-4"
    >
      <p className="text-sm font-medium text-danger">{title}</p>
      {detail ? <p className="mt-1 text-xs text-danger/80">{detail}</p> : null}
    </div>
  );
}

export function LoadingState({ label = "กำลังโหลดข้อมูล..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 px-6 py-16 text-sm text-muted">
      <span className="size-4 animate-spin rounded-full border-2 border-line border-t-brand-600" />
      {label}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";
  const variants = {
    primary: "bg-brand-600 text-white hover:bg-brand-700",
    secondary: "border border-line bg-surface text-ink hover:bg-canvas",
    danger: "bg-danger text-white hover:opacity-90",
    ghost: "text-brand-700 hover:bg-brand-50",
  };
  const sizes = { sm: "px-2.5 py-1.5 text-xs", md: "px-4 py-2 text-sm" };

  return (
    <button type={type} className={clsx(base, variants[variant], sizes[size], className)} {...rest}>
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
  error,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100";

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
