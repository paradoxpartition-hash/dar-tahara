export type SchedulableFlag = {
  enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
};

export function isActive(flag: SchedulableFlag, now = new Date()): boolean {
  if (!flag.enabled) return false;
  const time = now.getTime();
  if (flag.starts_at && Date.parse(flag.starts_at) > time) return false;
  if (flag.ends_at && Date.parse(flag.ends_at) <= time) return false;
  return true;
}
