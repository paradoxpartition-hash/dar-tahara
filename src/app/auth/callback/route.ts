import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/portal-auth";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  if (code) { const supabase = await createClient(); await supabase.auth.exchangeCodeForSession(code); }
  return NextResponse.redirect(new URL(next, req.nextUrl.origin), 303);
}
