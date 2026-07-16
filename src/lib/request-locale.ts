import "server-only";

import { cookies } from "next/headers";
import { isLocale, type Locale } from "@/i18n/config";

export async function getRequestLocale(): Promise<Locale> {
  const value = (await cookies()).get("NEXT_LOCALE")?.value;
  return value && isLocale(value) ? value : "en";
}
