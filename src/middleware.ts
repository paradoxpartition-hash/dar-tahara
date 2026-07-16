import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { locales } from "./i18n/config";
import { resolveLocale, countryFromHeaders } from "./lib/geo-language";
import { site } from "./lib/site";

const PUBLIC_FILE = /\.(.*)$/;

function copyCookies(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach((cookie) => to.cookies.set(cookie));
  return to;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host")?.split(":")[0] || "";

  if (host && host !== site.domain && host !== "localhost" && host !== "127.0.0.1") {
    const url = request.nextUrl.clone();
    url.protocol = "https";
    url.host = site.domain;
    return NextResponse.redirect(url, 308);
  }

  let authResponse = NextResponse.next({ request });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseKey) {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values) {
          values.forEach(({ name, value }) => request.cookies.set(name, value));
          authResponse = NextResponse.next({ request });
          values.forEach(({ name, value, options }) => authResponse.cookies.set(name, value, options));
        },
      },
    });
    await supabase.auth.getUser();
  }

  // Skip internal paths, API routes and static files.
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/auth/") ||
    pathname === "/login" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    PUBLIC_FILE.test(pathname)
  ) {
    return authResponse;
  }

  // Already locale-prefixed → never redirect (lets users & crawlers open any
  // language directly; no forced redirect away from a chosen locale).
  const hasLocale = locales.some(
    (l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`),
  );
  if (hasLocale) return authResponse;

  // Resolve: saved cookie → browser language → IP country → English.
  const { locale, source } = resolveLocale({
    savedLocale: request.cookies.get("NEXT_LOCALE")?.value,
    acceptLanguage: request.headers.get("accept-language"),
    countryCode: countryFromHeaders(request.headers),
  });

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  const res = copyCookies(authResponse, NextResponse.redirect(url));
  // Surface the detection outcome for privacy-conscious client analytics.
  res.headers.set("x-locale-source", source);
  return res;
}

export const config = {
  matcher: ["/((?!_next|api|.*\\..*).*)"],
};
