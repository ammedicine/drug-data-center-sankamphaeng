import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthLayout } from "@/components/ui/auth-layout";
import { getSession } from "@/lib/auth/session";

import { LoginForm } from "./login-form";

export const metadata = { title: "เข้าสู่ระบบ" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/dashboard");

  return (
    <AuthLayout
      title="เข้าสู่ระบบ"
      description="ใช้ชื่อผู้ใช้ (user id) หรืออีเมลที่ได้รับจากผู้ดูแลระบบ"
      footer={
        <>
          <p>
            ยังไม่มีบัญชี?{" "}
            <Link href="/register" className="font-medium text-brand hover:underline">
              สมัครสมาชิก
            </Link>
          </p>
          <p className="mt-2 text-xs">การเข้าใช้งานทุกครั้งถูกบันทึกไว้เพื่อการตรวจสอบ</p>
        </>
      }
    >
      <LoginForm />
    </AuthLayout>
  );
}
