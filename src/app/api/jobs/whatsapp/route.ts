import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { drainWhatsAppQueue, retryDueEscalations, runWhatsAppRetention } from "@/lib/whatsapp/orchestrator";
import { secureTokenEqual } from "@/lib/whatsapp/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorized(req: NextRequest): Promise<boolean> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null;
  return await isAdminAuthorized() || secureTokenEqual(bearer, process.env.WHATSAPP_JOB_SECRET);
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; maxJobs?: unknown };
  if (body.action === "retention") {
    return NextResponse.json({ ok: true, deleted: await runWhatsAppRetention() });
  }
  const maxJobs = typeof body.maxJobs === "number" ? body.maxJobs : 25;
  const [queue, escalations] = await Promise.all([
    drainWhatsAppQueue(maxJobs),
    retryDueEscalations(10),
  ]);
  return NextResponse.json({ ok: true, queue, escalations });
}
