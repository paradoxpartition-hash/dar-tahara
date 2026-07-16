import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { runAssistantKnowledgeRetention } from "@/lib/assistant/knowledge-builder";
import { secureTokenEqual } from "@/lib/whatsapp/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runRetention(req: NextRequest) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null;
  const hasJobToken = secureTokenEqual(bearer, process.env.ASSISTANT_JOB_SECRET)
    || secureTokenEqual(bearer, process.env.CRON_SECRET);
  if (!await isAdminAuthorized() && !hasJobToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, deleted: await runAssistantKnowledgeRetention() });
}

// Vercel Cron invokes routes with GET and sends CRON_SECRET as a bearer token.
export const GET = runRetention;
export const POST = runRetention;
