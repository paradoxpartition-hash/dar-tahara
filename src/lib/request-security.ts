import type { NextRequest } from "next/server";

export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  try { return new URL(origin).origin === req.nextUrl.origin; } catch { return false; }
}
