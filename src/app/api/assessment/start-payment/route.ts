import { NextResponse } from "next/server";
export const runtime = "nodejs";
export async function POST(){return NextResponse.json({error:"legacy_endpoint"},{status:410})}
