import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";

import { LoginForm } from "./login-form";

export const metadata = { title: "เข้าสู่ระบบ" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-semibold text-white">
            ยา
          </div>
          <h1 className="text-lg font-semibold text-ink">ศูนย์ข้อมูลการใช้ยา</h1>
          <p className="mt-1 text-sm text-muted">อำเภอสันกำแพง จังหวัดเชียงใหม่</p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,32,46,0.04)]">
          <LoginForm />
        </div>

        <p className="mt-6 text-center text-xs text-muted">
          ระบบนี้สำหรับเจ้าหน้าที่ที่ได้รับอนุญาตเท่านั้น การเข้าใช้งานถูกบันทึกไว้
        </p>
      </div>
    </main>
  );
}
