import { NextResponse } from "next/server";
import { dashboardForRoles, getAuthContext } from "@/lib/portal-auth";

export async function GET(){const context=await getAuthContext();return context?NextResponse.json({authenticated:true,destination:dashboardForRoles(context.roles)}):NextResponse.json({authenticated:false})}
