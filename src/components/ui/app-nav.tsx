"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Building2,
  ClipboardList,
  Cpu,
  LayoutDashboard,
  LogOut,
  Menu,
  Pill,
  RefreshCcw,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/**
 * Icons are named rather than passed as components so the section list can be
 * built in the server layout and serialised across the boundary.
 */
export type NavIconName =
  | "dashboard"
  | "report"
  | "sync"
  | "facility"
  | "agent"
  | "users"
  | "monitoring"
  | "audit";

const ICONS: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  report: Pill,
  sync: RefreshCcw,
  facility: Building2,
  agent: Cpu,
  users: Users,
  monitoring: Activity,
  audit: ClipboardList,
};

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({
  sections,
  pathname,
  onNavigate,
}: {
  sections: NavSection[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="เมนูหลัก">
      {sections.map((section) => (
        <div key={section.title} className="mb-5 last:mb-0">
          <p className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wide text-shell-muted">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const Icon = ICONS[item.icon];
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex items-center gap-2.5 rounded-[6px] py-2 pl-2.5 pr-2 text-[13.5px] transition-colors duration-150 ${
                      active
                        ? "bg-shell-hover font-medium text-white"
                        : "text-shell-text hover:bg-shell-hover hover:text-white"
                    }`}
                  >
                    {/* the accent bar, not a bright fill, marks the current page */}
                    <span
                      aria-hidden
                      className={`absolute inset-y-1.5 left-0 w-0.5 rounded-full ${
                        active ? "bg-brand" : "bg-transparent"
                      }`}
                    />
                    <Icon aria-hidden className="size-[18px] shrink-0" />
                    <span className="min-w-0 truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Identity() {
  return (
    <div className="flex items-center gap-2.5 border-b border-shell-line px-4 py-3.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-brand text-[13px] font-semibold text-white">
        ยา
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold text-white">
          ศูนย์ข้อมูลการใช้ยา
        </span>
        <span className="block truncate text-[11.5px] text-shell-muted">
          อำเภอสันกำแพง จ.เชียงใหม่
        </span>
      </span>
    </div>
  );
}

function Account({
  fullName,
  roleLabel,
  logout,
}: {
  fullName: string;
  roleLabel: string;
  logout: ReactFormAction;
}) {
  return (
    <div className="border-t border-shell-line px-4 py-3">
      <p className="truncate text-[13px] font-medium text-white">{fullName}</p>
      <p className="truncate text-[11.5px] text-shell-muted">{roleLabel}</p>
      <form action={logout} className="mt-2">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-[6px] py-1 text-xs text-shell-text transition-colors duration-150 hover:text-white"
        >
          <LogOut aria-hidden className="size-3.5" />
          ออกจากระบบ
        </button>
      </form>
    </div>
  );
}

type ReactFormAction = (formData: FormData) => void | Promise<void>;

/**
 * Desktop: a fixed dark rail. Mobile: a compact bar plus a drawer, because a
 * sidebar folded into stacked rows pushes the actual page below the fold.
 */
export function AppNav({
  sections,
  fullName,
  roleLabel,
  logout,
}: {
  sections: NavSection[];
  fullName: string;
  roleLabel: string;
  logout: ReactFormAction;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the drawer on navigation and on Escape; a drawer left open over the
  // page it just navigated to is a common and irritating bug.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* desktop rail */}
      <aside
        data-app-nav
        className="hidden shrink-0 flex-col bg-shell lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[252px]"
      >
        <Identity />
        <NavLinks sections={sections} pathname={pathname} />
        <Account fullName={fullName} roleLabel={roleLabel} logout={logout} />
      </aside>

      {/* mobile bar */}
      <div
        data-app-nav
        className="sticky top-0 z-30 flex items-center gap-3 bg-shell px-3 py-2.5 lg:hidden"
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="เปิดเมนู"
          aria-expanded={open}
          className="rounded-[6px] p-1.5 text-shell-text transition-colors duration-150 hover:bg-shell-hover hover:text-white"
        >
          <Menu aria-hidden className="size-5" />
        </button>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-brand text-xs font-semibold text-white">
          ยา
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-white">
          ศูนย์ข้อมูลการใช้ยา
        </span>
        <span className="max-w-[38%] truncate text-[11.5px] text-shell-muted">{fullName}</span>
      </div>

      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="ปิดเมนู"
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full bg-ink/45"
          />
          <div className="relative flex h-full w-[82%] max-w-[300px] flex-col bg-shell">
            <div className="flex items-center justify-between border-b border-shell-line pr-2">
              <div className="flex-1">
                <Identity />
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="ปิดเมนู"
                className="rounded-[6px] p-1.5 text-shell-text hover:bg-shell-hover hover:text-white"
              >
                <X aria-hidden className="size-5" />
              </button>
            </div>
            <NavLinks sections={sections} pathname={pathname} onNavigate={() => setOpen(false)} />
            <Account fullName={fullName} roleLabel={roleLabel} logout={logout} />
          </div>
        </div>
      ) : null}
    </>
  );
}
