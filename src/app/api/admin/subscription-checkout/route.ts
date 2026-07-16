import{NextResponse}from"next/server";
export async function POST(){return NextResponse.json({error:"customer_acceptance_required"},{status:410})}
