"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, Card, Notice, inputClass } from "@/components/ui/primitives";

import { abandonApprovedStaleBatchAction, type ActionState } from "../actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={pending}>
      {pending ? "กำลังบันทึก..." : "บันทึกเป็น ABORTED"}
    </Button>
  );
}

export function StaleBatchAbandonmentPanel({ batchRef }: { batchRef: string }) {
  const [state, action] = useActionState(abandonApprovedStaleBatchAction, {} as ActionState);

  return (
    <Card
      className="mb-5"
      title="ปิด legacy batch ที่สร้างใหม่ไม่ได้"
      description="SUPER_ADMIN เท่านั้น · บันทึกความจริงทางประวัติศาสตร์ ไม่ใช่ recovery หรือ completion"
    >
      <form
        action={action}
        className="space-y-3 p-5"
        onSubmit={(event) => {
          if (!window.confirm(`ยืนยันปิด ${batchRef} เป็น ABORTED?`)) {
            event.preventDefault();
          }
        }}
      >
        {state.error || state.success ? (
          <Notice tone={state.error ? "danger" : "ok"}>{state.error ?? state.success}</Notice>
        ) : null}
        <input type="hidden" name="batchRef" value={batchRef} />
        <div className="text-sm">
          <span className="text-muted">Batch: </span>
          <span className="font-mono font-medium text-ink">{batchRef}</span>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted">เหตุผลทางการบริหาร (บันทึกใน audit)</span>
          <textarea
            name="reason"
            required
            maxLength={500}
            rows={2}
            className={inputClass}
            placeholder="ระบุหลักฐานที่ใช้ยืนยันว่า batch นี้ stale และไม่สามารถ reconstruct ได้"
          />
        </label>
        <p className="text-xs text-muted">
          การทำรายการนี้ไม่แก้ข้อมูลยา counters, Agent status หรือ watermark และทำได้เฉพาะ batch ที่อนุมัตินี้
        </p>
        <Submit />
      </form>
    </Card>
  );
}
