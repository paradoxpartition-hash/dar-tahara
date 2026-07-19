import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthorized, adminConfigured } from "@/lib/admin-auth";
import {
  validateCampaignSource,
  toCampaignSourceRow,
  buildTrackedUrl,
} from "@/lib/campaign-sources";
import { serviceInsert, serviceSelect, isServiceRoleConfigured } from "@/lib/supabase-rpc";
import { fetchPageViewStats } from "@/lib/early-access/page-view-recorder";
import { indexStatsBySource, type PageViewStat } from "@/lib/early-access/page-views";

export const runtime = "nodejs";

type SourceRow = {
  id: string;
  internal_name: string;
  source_code: string;
  source_channel: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  status: string;
  created_at: string;
};

function withUrl(row: SourceRow, stat?: PageViewStat) {
  return {
    ...row,
    views: Number(stat?.views ?? 0),
    unique_visitors: Number(stat?.unique_visitors ?? 0),
    last_view_at: stat?.last_view_at ?? null,
    tracked_url: buildTrackedUrl({
      sourceCode: row.source_code,
      utmSource: row.utm_source ?? undefined,
      utmMedium: row.utm_medium ?? undefined,
      utmCampaign: row.utm_campaign ?? undefined,
      utmContent: row.utm_content ?? undefined,
      utmTerm: row.utm_term ?? undefined,
    }),
  };
}

/** List campaign sources (admin only). */
export async function GET(req: NextRequest) {
  if (!adminConfigured() || !(await isAdminAuthorized())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isServiceRoleConfigured()) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  try {
    // View counts are a nice-to-have: fetchPageViewStats never throws, so a
    // missing stats view degrades the list to zeroes instead of a 500.
    const [rows, stats] = await Promise.all([
      serviceSelect<SourceRow[]>("campaign_sources?select=*&order=created_at.desc&limit=500"),
      fetchPageViewStats(),
    ]);
    const { bySource, untagged, totalViews } = indexStatsBySource(stats);
    return NextResponse.json({
      ok: true,
      sources: rows.map((r) => withUrl(r, bySource.get(r.source_code))),
      views: {
        total: totalViews,
        untagged: Number(untagged?.views ?? 0),
      },
    });
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

/** Create a campaign source (admin only). Returns the row + its tracked URL. */
export async function POST(req: NextRequest) {
  if (!adminConfigured() || !(await isAdminAuthorized())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isServiceRoleConfigured()) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const validated = validateCampaignSource(body);
  if (!validated.ok) {
    return NextResponse.json({ error: "validation_failed", fields: validated.errors }, { status: 400 });
  }

  try {
    const inserted = await serviceInsert<SourceRow[]>(
      "campaign_sources",
      toCampaignSourceRow(validated.value),
    );
    return NextResponse.json({ ok: true, source: withUrl(inserted[0]) });
  } catch (e) {
    // Duplicate source_code hits the unique constraint.
    if (String(e).includes("23505") || String(e).toLowerCase().includes("duplicate")) {
      return NextResponse.json({ error: "duplicate_code", fields: { sourceCode: "duplicate" } }, { status: 409 });
    }
    console.error("[campaign-sources] insert failed");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
