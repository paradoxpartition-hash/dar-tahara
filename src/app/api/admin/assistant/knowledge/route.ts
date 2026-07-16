import { NextRequest, NextResponse } from "next/server";
import { loadKnowledgeBuilderDashboard, updateKnowledgeBuilderQuestion } from "@/lib/assistant/knowledge-builder";
import { authorizeApi } from "@/lib/portal-auth";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorizeApi(["administrator"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    return NextResponse.json(await loadKnowledgeBuilderDashboard());
  } catch {
    return NextResponse.json({ error: "knowledge_builder_not_configured" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await authorizeApi(["administrator"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await req.json().catch(() => null) as { id?: unknown; action?: unknown; answer?: unknown } | null;
  const action = typeof body?.action === "string" && ["answer", "approve", "reject", "needs_clarification", "archive", "supersede"].includes(body.action)
    ? body.action as "answer" | "approve" | "reject" | "needs_clarification" | "archive" | "supersede"
    : null;
  if (typeof body?.id !== "string" || !action) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    await updateKnowledgeBuilderQuestion({
      id: body.id,
      action,
      answer: typeof body.answer === "string" ? body.answer : undefined,
      actorUserId: auth.context.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "knowledge_builder_update_failed";
    return NextResponse.json({ error: message }, { status: message.endsWith("required") ? 400 : 500 });
  }
}
