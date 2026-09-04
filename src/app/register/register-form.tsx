"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, Field, inputClass } from "@/components/ui/primitives";

import { registerAction, type RegisterState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "กำลังสมัคร..." : "สมัครสมาชิก"}
    </Button>
  );
}

export function RegisterForm() {
  const [state, formAction] = useActionState<RegisterState, FormData>(registerAction, {});

  if (state.success) {
    return (
      <div className="space-y-4 text-center">
        <p className="rounded-lg bg-ok-bg px-4 py-3 text-sm text-ok">{state.success}</p>
        <Link href="/login" className="inline-block text-sm font-medium text-brand-700 hover:underline">
          ไปหน้าเข้าสู่ระบบ
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger">
          {state.error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="ชื่อ-นามสกุล">
          <input name="fullName" required className={inputClass} placeholder="สมชาย ใจดี" />
        </Field>
        <Field label="ตำแหน่ง">
          <input name="position" required className={inputClass} placeholder="พยาบาลวิชาชีพ" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="รหัสสถานบริการ" hint="ตัวเลข 5 หลัก เช่น 05957">
          <input
            name="facilityCode"
            required
            inputMode="numeric"
            maxLength={5}
            className={inputClass}
            placeholder="05957"
          />
        </Field>
        <Field label="ชื่อสถานบริการ">
          <input
            name="facilityName"
            required
            className={inputClass}
            placeholder="รพ.สต.บ้านกอสะเลียม"
          />
        </Field>
      </div>

      <Field label="ชื่อผู้ใช้ (user id)" hint="ใช้เข้าสู่ระบบ 4-60 ตัว a-z 0-9 . _ -">
        <input name="username" required autoComplete="username" className={inputClass} placeholder="somchai.j" />
      </Field>

      <Field label="อีเมล (ไม่บังคับ)">
        <input name="email" type="email" autoComplete="email" className={inputClass} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="รหัสผ่าน" hint="อย่างน้อย 10 ตัว มีตัวอักษรและตัวเลข">
          <input
            name="password"
            type="password"
            required
            autoComplete="new-password"
            className={inputClass}
          />
        </Field>
        <Field label="ยืนยันรหัสผ่าน">
          <input
            name="confirmPassword"
            type="password"
            required
            autoComplete="new-password"
            className={inputClass}
          />
        </Field>
      </div>

      <p className="rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
        บัญชีใหม่จะเห็นข้อมูลเฉพาะสถานบริการที่ระบุเท่านั้น และต้องรอผู้ดูแลระบบอนุมัติก่อนเข้าใช้งาน
      </p>

      <SubmitButton />
    </form>
  );
}
