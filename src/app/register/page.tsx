import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthLayout } from "@/components/ui/auth-layout";
import { getSession } from "@/lib/auth/session";

import { RegisterForm } from "./register-form";

export const metadata = { title: "สมัครสมาชิก" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await getSession()) redirect("/dashboard");

  return (
    <AuthLayout
      title="สมัครสมาชิก"
      description="กรอกข้อมูลเจ้าหน้าที่และรหัสสถานบริการ บัญชีจะใช้งานได้หลังผู้ดูแลระบบส่วนกลางอนุมัติ"
      footer={
        <p>
          มีบัญชีอยู่แล้ว?{" "}
          <Link href="/login" className="font-medium text-brand hover:underline">
            เข้าสู่ระบบ
          </Link>
        </p>
      }
    >
      <RegisterForm />
    </AuthLayout>
  );
}
