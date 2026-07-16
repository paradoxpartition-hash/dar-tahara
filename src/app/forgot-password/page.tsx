import { AuthShell } from "@/components/auth/auth-shell";
import { ResetRequestForm } from "@/components/auth/auth-form";
import { portalCopy } from "@/i18n/portal-copy";
import { getRequestLocale } from "@/lib/request-locale";

export const metadata = { title: "Reset password · Dar Tahara", robots: { index: false, follow: false } };
export default async function ForgotPasswordPage(){const copy=portalCopy[await getRequestLocale()].auth;return <AuthShell title={copy.resetTitle} intro={copy.resetIntro}><ResetRequestForm copy={copy}/></AuthShell>}
