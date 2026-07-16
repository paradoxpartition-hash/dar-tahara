import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSameOrigin } from "@/lib/request-security";

export async function POST(req:NextRequest){if(!isSameOrigin(req))return NextResponse.json({error:"invalid_request"},{status:403});const supabase=await createClient();await supabase.auth.signOut();return NextResponse.json({ok:true})}
