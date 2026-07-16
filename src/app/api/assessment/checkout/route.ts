import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

export async function POST(_req: NextRequest) {
  return NextResponse.json({ error: "legacy_endpoint", replacement: "/api/assessment/apply" }, { status: 410 });
}
