import type { ReactNode } from "react";
import { PortalShell } from "@/components/portal/portal-shell";
import { portalCopy } from "@/i18n/portal-copy";
import { getRequestLocale } from "@/lib/request-locale";
import { requireAuth } from "@/lib/portal-auth";

export const metadata={title:"My Account · Dar Tahara",robots:{index:false,follow:false}};
export default async function AccountLayout({children}:{children:ReactNode}){const context=await requireAuth();const copy=portalCopy[await getRequestLocale()];return <PortalShell copy={copy} email={context.user.email||""}>{children}</PortalShell>}
