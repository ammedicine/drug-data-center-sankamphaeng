"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, Field, inputClass } from "@/components/ui/primitives";

import { loginAction, type LoginState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
    </Button>
  );
}

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger">
          {state.error}
        </p>
      ) : null}

      <Field label="อีเมล">
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className={inputClass}
          placeholder="you@sankamphaeng.go.th"
        />
      </Field>

      <Field label="รหัสผ่าน">
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
          placeholder="••••••••"
        />
      </Field>

      <SubmitButton />
    </form>
  );
}
