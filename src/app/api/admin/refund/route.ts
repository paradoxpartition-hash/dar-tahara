import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { validateRefundRequest } from "@/lib/refunds";
import { createRefund } from "@/lib/stripe";
import { isServiceRoleConfigured, serviceSelect, serviceUpsert, serviceUpdate, serviceInsert } from "@/lib/supabase-rpc";

export const runtime = "nodejs";

type AssessmentRow = {
  id: string;
  customer_id: string;
  stripe_payment_intent_id: string | null;
  assessment_price_cents: number;
  payment_status: string;
};

/** Admin-only refund (full or partial) with audit logging. */
export async function POST(req: NextRequest) {
  if (!isAdminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isServiceRoleConfigured() || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as { assessmentId?: string } | null;
  const assessmentId = body?.assessmentId;
  if (!assessmentId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const rows = await serviceSelect<AssessmentRow[]>(
    `home_assessments?id=eq.${encodeURIComponent(assessmentId)}&select=id,customer_id,stripe_payment_intent_id,assessment_price_cents,payment_status&limit=1`,
  );
  const assessment = rows[0];
  if (!assessment) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const validation = validateRefundRequest(body, {
    paidCents: assessment.assessment_price_cents,
    paymentStatus: assessment.payment_status,
    paymentIntentId: assessment.stripe_payment_intent_id,
  });
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  try {
    const refund = await createRefund({
      paymentIntentId: validation.value.paymentIntentId,
      amountCents: validation.value.amountCents,
      reason: validation.value.reason,
      internalReason: validation.value.note,
      idempotencyKey: `admin_refund_${assessmentId}_${randomUUID()}`,
    });

    const fully = !validation.value.amountCents || validation.value.amountCents >= assessment.assessment_price_cents;
    await serviceUpsert(
      "refunds",
      {
        stripe_refund_id: refund.id,
        stripe_charge_id: refund.charge,
        stripe_payment_intent_id: refund.payment_intent,
        assessment_id: assessment.id,
        customer_id: assessment.customer_id,
        amount_cents: refund.amount,
        currency: refund.currency,
        reason: validation.value.reason ?? null,
        internal_note: validation.value.note ?? null,
        status: refund.status === "succeeded" ? "succeeded" : "pending",
        source: "admin",
      },
      "stripe_refund_id",
    );
    await serviceUpdate("home_assessments", `id=eq.${assessment.id}`, {
      payment_status: fully ? "refunded" : "partially_refunded",
    });
    await serviceInsert("assessment_events", {
      assessment_id: assessment.id,
      event_type: fully ? "refunded" : "partially_refunded",
      actor_type: "admin",
      actor_reference: refund.id,
      note: validation.value.note ?? null,
    });

    return NextResponse.json({ ok: true, refundId: refund.id, amountCents: refund.amount, status: refund.status });
  } catch (error) {
    console.error("[admin-refund]", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "refund_failed" }, { status: 502 });
  }
}
