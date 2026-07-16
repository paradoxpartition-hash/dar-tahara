import { NextRequest, NextResponse } from "next/server";
import { isServiceRoleConfigured, serviceInsert, serviceSelect } from "@/lib/supabase-rpc";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isServiceRoleConfigured()) return NextResponse.json({ error: "feedback_not_configured" }, { status: 503 });
  const body = await req.json().catch(() => null) as {
    conversationId?: unknown;
    sessionId?: unknown;
    rating?: unknown;
  } | null;
  if (typeof body?.conversationId !== "string" || typeof body.sessionId !== "string"
    || !["helpful", "unhelpful"].includes(String(body.rating))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const rows = await serviceSelect<Array<{ metadata: Record<string, unknown> | null }>>(
    `assistant_conversations?id=eq.${encodeURIComponent(body.conversationId)}&select=metadata&limit=1`,
  ).catch(() => []);
  if (!rows[0] || rows[0].metadata?.session_id !== body.sessionId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await serviceInsert("assistant_feedback", { conversation_id: body.conversationId, rating: body.rating });
  await serviceInsert("assistant_audit_logs", {
    actor_type: "customer",
    actor_reference: "website",
    action: "answer_feedback_recorded",
    subject_table: "assistant_conversations",
    subject_id: body.conversationId,
    metadata: { rating: body.rating },
  });
  return NextResponse.json({ ok: true });
}
