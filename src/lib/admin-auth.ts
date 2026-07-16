import "server-only";
import { authorizeApi } from "@/lib/portal-auth";
import { isServiceRoleConfigured } from "@/lib/supabase-rpc";

export async function isAdminAuthorized(): Promise<boolean> {
  return (await authorizeApi(["administrator"])).ok;
}
export async function isStaffAuthorized(): Promise<boolean> {
  return (await authorizeApi(["staff", "administrator"])).ok;
}
export function adminConfigured(): boolean { return isServiceRoleConfigured(); }
