import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";

import { RegisterForm } from "./register-form";

export const metadata = { title: "สมัครสมาชิก" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await getSession()) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-semibold text-white">
            ยา
          </div>
          <h1 className="text-lg font-semibold text-ink">สมัครสมาชิก</h1>
          <p className="mt-1 text-sm text-muted">
            ศูนย์ข้อมูลการใช้ยา อำเภอสันกำแพง จังหวัดเชียงใหม่
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,32,46,0.04)]">
          <RegisterForm />
        </div>

        <p className="mt-6 text-center text-sm text-muted">
          มีบัญชีอยู่แล้ว?{" "}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            เข้าสู่ระบบ
          </Link>
        </p>
      </div>
    </main>
  );
}
