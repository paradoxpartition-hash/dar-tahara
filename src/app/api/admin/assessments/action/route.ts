import { NextRequest, NextResponse } from "next/server";
import { adminConfigured } from "@/lib/admin-auth";
import { authorizeApi } from "@/lib/portal-auth";
import { serviceInsert, serviceSelect, serviceUpdate } from "@/lib/supabase-rpc";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import type { Locale } from "@/i18n/config";
import { sendWhatsAppText } from "@/lib/whatsapp";

export const runtime = "nodejs";
const ACTIONS = new Set(["review", "contact", "schedule", "complete", "request_info", "approve", "reject", "cancel", "assign", "message"]);
function nextStatus(action:string,current:string){if(action==="complete")return current==="assessment"?"pending_review":"assessment_completed";return {review:"under_review",contact:"contacted",schedule:"assessment_scheduled",request_info:"additional_information_required",approve:"approved",reject:"rejected",cancel:"cancelled"}[action]||current}

type Row = { id: string; reference: string; status: string; customer_id: string; property_id: string; requested_frequency: string; estimated_monthly_cents: number | null; requested_billing_interval: "monthly" | "annual"; customers: { email: string; phone:string; full_name: string; preferred_language: Locale } };

export async function POST(req: NextRequest) {
  if (!adminConfigured()) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const auth=await authorizeApi(["staff","administrator"]);if(!auth.ok)return NextResponse.json({error:auth.error},{status:auth.status});
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (["approve","reject"].includes(action) && !(await authorizeApi(["administrator"])).ok) return NextResponse.json({error:"forbidden"},{status:403});
  if (!/^[0-9a-f-]{36}$/i.test(id) || !ACTIONS.has(action)) return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  const rows = await serviceSelect<Row[]>(`home_assessments?id=eq.${id}&select=id,reference,status,customer_id,property_id,requested_frequency,estimated_monthly_cents,requested_billing_interval,customers(email,phone,full_name,preferred_language)&limit=1`);
  const row = rows[0];
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (action === "assign") {
    const cleaner = typeof body.cleanerId === "string" && /^[0-9a-f-]{36}$/i.test(body.cleanerId) ? body.cleanerId : null;
    const inspector = typeof body.inspectorId === "string" && /^[0-9a-f-]{36}$/i.test(body.inspectorId) ? body.inspectorId : null;
    await serviceUpdate("home_assessments", `id=eq.${id}`, { assigned_cleaner_id: cleaner, assigned_inspector_id: inspector });
    await serviceInsert("assessment_events", { assessment_id:id,event_type:"staff_assigned",actor_type:"admin",metadata:{cleanerId:cleaner,inspectorId:inspector} });
    return NextResponse.json({ok:true,status:row.status});
  }
  if (action === "message") {
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 1500) : "";
    if (!message) return NextResponse.json({error:"message_required"},{status:400});
    const sent = await sendWhatsAppText(row.customers.phone, message);
    await serviceInsert("customer_messages", {customer_id:row.customer_id,assessment_id:id,channel:"whatsapp",direction:"outbound",recipient:row.customers.phone,body:message,provider_message_id:sent.id,status:sent.id?"sent":"failed",metadata:{actor:"admin"}});
    return NextResponse.json({ok:true,status:row.status});
  }
  const next=nextStatus(action,row.status);
  const updates: Record<string, unknown> = { status: next, assessment_notes: typeof body.notes === "string" ? body.notes.slice(0, 5000) : null };
  if (action === "review") updates.assessment_started_at = new Date().toISOString();
  if (action === "schedule") { const scheduled=typeof body.scheduledAt==="string"?body.scheduledAt:"";if(!scheduled||!Number.isFinite(Date.parse(scheduled)))return NextResponse.json({error:"invalid_schedule"},{status:400});updates.scheduled_at=new Date(scheduled).toISOString(); }
  if (action === "complete") updates.assessment_completed_at = new Date().toISOString();
  if (action === "reject") updates.decline_reason = typeof body.notes === "string" ? body.notes.slice(0, 2000) : null;
  if (action === "approve" && row.estimated_monthly_cents === null) {
    return NextResponse.json({ error: "proposal_amount_required" }, { status: 409 });
  }
  await serviceUpdate("home_assessments", `id=eq.${id}`, updates);
  if (action === "approve") {
    const monthly = row.estimated_monthly_cents;
    if (monthly === null) return NextResponse.json({ error: "proposal_amount_required" }, { status: 409 });
    const billed = row.requested_billing_interval === "annual" ? Math.round(monthly * 12 * 0.95) : monthly;
    await serviceInsert("subscription_proposals", { customer_id: row.customer_id, property_id: row.property_id, assessment_id: id, status:"ready", frequency: row.requested_frequency, billing_interval: row.requested_billing_interval, recurring_amount_cents: billed, discount_basis_points: row.requested_billing_interval === "annual" ? 500 : 0, terms_version:"2026-07", expires_at:new Date(Date.now()+14*86400000).toISOString(), created_by:auth.context.user.id });
    await serviceInsert("notification_outbox",{customer_id:row.customer_id,template_key:"subscription_proposal_ready",locale:row.customers.preferred_language,channel:"email",recipient:row.customers.email,consent_confirmed:true,payload:{reference:row.reference}});
    await sendTransactionalEmail({template:"subscription_proposal",locale:row.customers.preferred_language,email:row.customers.email,name:row.customers.full_name,reference:row.reference,amount:new Intl.NumberFormat(row.customers.preferred_language,{style:"currency",currency:"EUR"}).format(billed/100),actionUrl:`${process.env.NEXT_PUBLIC_SITE_URL||"https://dartahara.com"}/login?next=/account/subscriptions`});
  }
  await serviceInsert("assessment_events", { assessment_id: id, event_type: action, from_status: row.status, to_status: next, actor_type: "admin", actor_reference:auth.context.user.id, note: typeof body.notes === "string" ? body.notes.slice(0, 2000) : null });
  await serviceInsert("audit_logs",{actor_user_id:auth.context.user.id,action:`assessment_${action}`,resource_type:"home_assessment",resource_id:id,previous_value:{status:row.status},new_value:{status:next}});
  if (action === "complete") await sendTransactionalEmail({ template: "assessment_completed", locale: row.customers.preferred_language, email: row.customers.email, name: row.customers.full_name, reference: row.reference });
  if (action === "reject") await sendTransactionalEmail({ template: "subscription_declined", locale: row.customers.preferred_language, email: row.customers.email, name: row.customers.full_name, reference: row.reference });
  return NextResponse.json({ ok: true, status: next });
}
