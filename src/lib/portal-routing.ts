export type RoutableRole = "applicant" | "customer" | "staff" | "administrator";

export function dashboardForRoles(roles: readonly RoutableRole[]): string {
  if (roles.includes("administrator")) return "/admin";
  if (roles.includes("staff")) return "/admin/assessments";
  if (roles.includes("customer")) return "/account";
  return "/account/assessments";
}

export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/account";
  return value;
}
