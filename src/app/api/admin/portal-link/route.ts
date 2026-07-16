import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { createBillingPortalSession } from "@/lib/stripe";
import { isServiceRoleConfigured, serviceSelect } from "@/lib/supabase-rpc";
import { isLocale, type Locale } from "@/i18n/config";
import { site } from "@/lib/site";

export const runtime = "nodejs";

type CustomerRow = { id: string; stripe_customer_id: string | null; preferred_language: string };

/**
 * Generate a Stripe Customer Portal link for a customer (admin-authorized).
 * Customers use it to update payment methods, view invoices and manage/cancel
 * their subscription. Ownership is enforced by the admin gate + explicit id;
 * a self-service customer flow can later reuse createBillingPortalSession once
 * a customer login area exists.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthorized())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isServiceRoleConfigured() || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as { customerId?: string } | null;
  if (!body?.customerId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const rows = await serviceSelect<CustomerRow[]>(
    `customers?id=eq.${encodeURIComponent(body.customerId)}&select=id,stripe_customer_id,preferred_language&limit=1`,
  );
  const customer = rows[0];
  if (!customer) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!customer.stripe_customer_id) return NextResponse.json({ error: "no_stripe_customer" }, { status: 400 });

  const locale: Locale = isLocale(customer.preferred_language) ? customer.preferred_language : "en";
  try {
    const session = await createBillingPortalSession({
      customerId: customer.stripe_customer_id,
      locale,
      returnUrl: `${process.env.NEXT_PUBLIC_SITE_URL || site.url}/${locale}`,
    });
    return NextResponse.json({ ok: true, url: session.url });
  } catch (error) {
    console.error("[admin-portal-link]", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "portal_failed" }, { status: 502 });
  }
}
