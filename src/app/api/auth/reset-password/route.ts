import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSameOrigin } from "@/lib/request-security";

export async function POST(req:NextRequest){if(!isSameOrigin(req))return NextResponse.json({error:"invalid_request"},{status:403});const body=await req.json().catch(()=>({})) as {password?:unknown};if(typeof body.password!=="string"||body.password.length<12)return NextResponse.json({error:"invalid_password"},{status:400});const supabase=await createClient();const {error}=await supabase.auth.updateUser({password:body.password});return error?NextResponse.json({error:"invalid_session"},{status:401}):NextResponse.json({ok:true})}
