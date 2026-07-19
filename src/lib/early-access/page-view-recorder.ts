import "server-only";
import { headers } from "next/headers";
import { serviceInsert, serviceSelect, isServiceRoleConfigured } from "@/lib/supabase-rpc";
import { clientIpFromHeaders } from "@/lib/mailing-list";
import { hashIp } from "./request-meta";
import { parseAttribution } from "./attribution";
import { buildPageViewRow, isLikelyBot, type PageViewStat } from "./page-views";

/**
 * Record one view of the early-access page. Server-side and cookieless: the
 * visitor's browser is never asked to store anything, so this needs no consent
 * banner and cannot be blocked by an ad blocker.
 *
 * FAIL-OPEN, ALWAYS. A counter is never worth a broken landing page, so every
 * failure path here — Supabase down, service role unset, malformed params —
 * returns quietly. Call it from `after()` so it also never delays the response.
 */
export async function recordEarlyAccessPageView(
  locale: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<void> {
  try {
    if (!isServiceRoleConfigured()) return;

    const h = await headers();
    if (isLikelyBot(h.get("user-agent"))) return;
    // Next prefetches the page on link hover; those are not views.
    if (h.get("next-router-prefetch") === "1" || h.get("purpose") === "prefetch") return;

    // Reuse the same parser (and the same sanitizing) the form attribution uses,
    // so a view and a submission agree on what a source code is.
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      const first = Array.isArray(v) ? v[0] : v;
      if (typeof first === "string") params.set(k, first);
    }

    const row = buildPageViewRow({
      locale,
      attribution: parseAttribution(params),
      ipHash: await hashIp(clientIpFromHeaders(h)),
    });

    await serviceInsert("early_access_page_views", row);
  } catch {
    // Intentionally silent: a dropped count must not surface to the visitor or
    // fill the logs on every request during an outage.
  }
}

/**
 * Per-source view aggregates for the admin campaign-links utility. Returns an
 * empty list rather than throwing so the sources table still renders (without
 * counts) if the stats view is missing — e.g. before this migration is applied.
 */
export async function fetchPageViewStats(): Promise<PageViewStat[]> {
  try {
    if (!isServiceRoleConfigured()) return [];
    const rows = await serviceSelect<PageViewStat[]>(
      "early_access_page_view_stats?select=source_code,views,unique_visitors,first_view_at,last_view_at",
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
