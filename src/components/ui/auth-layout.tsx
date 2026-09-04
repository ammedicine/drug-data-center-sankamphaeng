import { Building2, DatabaseZap, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shell for /login and /register.
 *
 * Two columns on desktop: what this system is on the left, the form on the
 * right. The left column states plain facts about the platform - no imagery, no
 * claims - so the page reads as the front door of an internal system rather
 * than a product page. On small screens the context collapses to a header and
 * the form takes the whole width.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const facts = [
    {
      icon: DatabaseZap,
      title: "ข้อมูลจาก JHCIS โดยตรง",
      body: "โปรแกรมเชื่อมข้อมูลที่ติดตั้งใน รพ.สต. ส่งข้อมูลการจ่ายยาขึ้นศูนย์กลางอัตโนมัติ",
    },
    {
      icon: Building2,
      title: "แยกข้อมูลตามสถานบริการ",
      body: "แต่ละบัญชีเห็นเฉพาะข้อมูลของสถานบริการตนเอง ตรวจสอบสิทธิ์ที่ฝั่งเซิร์ฟเวอร์ทุกครั้ง",
    },
    {
      icon: ShieldCheck,
      title: "บันทึกการใช้งานทุกครั้ง",
      body: "การเข้าสู่ระบบ การแก้ไขข้อมูล และการส่งออกรายงาน ถูกบันทึกไว้ตรวจสอบย้อนหลังได้",
    },
  ];

  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(480px,45%)]">
      {/* context */}
      <section className="bg-shell px-6 py-8 lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-12">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[6px] bg-brand text-sm font-semibold text-white">
            ยา
          </span>
          <span>
            <span className="block text-[15px] font-semibold text-white">ศูนย์ข้อมูลการใช้ยา</span>
            <span className="block text-xs text-shell-muted">อำเภอสันกำแพง จังหวัดเชียงใหม่</span>
          </span>
        </div>

        <div className="mt-8 hidden max-w-md lg:mt-0 lg:block">
          <h2 className="text-[22px] font-semibold leading-snug text-white">
            ระบบรวบรวมและวิเคราะห์ปริมาณการจ่ายยา
            <br />
            ของโรงพยาบาลส่งเสริมสุขภาพตำบล
          </h2>
          <ul className="mt-8 space-y-5">
            {facts.map((fact) => (
              <li key={fact.title} className="flex gap-3">
                <fact.icon aria-hidden className="mt-0.5 size-[18px] shrink-0 text-brand" />
                <div>
                  <p className="text-[13.5px] font-medium text-white">{fact.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-shell-muted">{fact.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-8 hidden text-xs text-shell-muted lg:mt-0 lg:block">
          สำหรับเจ้าหน้าที่ที่ได้รับอนุญาตเท่านั้น
        </p>
      </section>

      {/* form */}
      <section className="flex items-center justify-center bg-surface px-4 py-10 sm:px-8 lg:px-12">
        <div className="w-full max-w-[420px]">
          <h1 className="text-[22px] font-semibold text-ink">{title}</h1>
          <p className="mt-1.5 text-[13px] text-muted">{description}</p>
          <div className="mt-6">{children}</div>
          {footer ? <div className="mt-6 text-[13px] text-muted">{footer}</div> : null}
        </div>
      </section>
    </main>
  );
}
