import { NextResponse } from "next/server";
export const runtime = "nodejs";
export async function POST(){return NextResponse.json({error:"legacy_endpoint",replacement:"/api/auth/login"},{status:410})}
export async function DELETE(){return NextResponse.json({error:"legacy_endpoint",replacement:"/api/auth/logout"},{status:410})}
