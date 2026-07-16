import { AuthShell } from "@/components/auth/auth-shell";
import { NewPasswordForm } from "@/components/auth/auth-form";
import { portalCopy } from "@/i18n/portal-copy";
import { getRequestLocale } from "@/lib/request-locale";

export const metadata = { title: "Choose password · Dar Tahara", robots: { index: false, follow: false } };
export default async function ResetPasswordPage(){const copy=portalCopy[await getRequestLocale()].auth;return <AuthShell title={copy.resetTitle}><NewPasswordForm copy={copy}/></AuthShell>}
