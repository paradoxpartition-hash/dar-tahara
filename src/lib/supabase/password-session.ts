type PasswordSessionResponse = {
  data: { session: object | null };
  error: unknown;
};

export type PasswordSessionAuth = {
  setSession(tokens: {
    access_token: string;
    refresh_token: string;
  }): Promise<PasswordSessionResponse>;
  getSession(): Promise<PasswordSessionResponse>;
};

type PasswordCallback =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "session"; accessToken: string; refreshToken: string };

export function parsePasswordCallback(hash: string): PasswordCallback {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!value) return { kind: "none" };

  const params = new URLSearchParams(value);
  const authKeys = [
    "access_token",
    "refresh_token",
    "type",
    "error",
    "error_code",
    "error_description",
  ];
  if (!authKeys.some((key) => params.has(key))) return { kind: "none" };
  if (params.has("error") || params.has("error_code") || params.has("error_description")) {
    return { kind: "invalid" };
  }

  const type = params.get("type");
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (
    (type === "invite" || type === "recovery") &&
    accessToken &&
    refreshToken
  ) {
    return { kind: "session", accessToken, refreshToken };
  }

  return { kind: "invalid" };
}

export async function establishPasswordSession(
  auth: PasswordSessionAuth,
  hash: string,
): Promise<{ ok: boolean; clearFragment: boolean }> {
  const callback = parsePasswordCallback(hash);
  if (callback.kind === "invalid") return { ok: false, clearFragment: true };

  if (callback.kind === "session") {
    const { data, error } = await auth.setSession({
      access_token: callback.accessToken,
      refresh_token: callback.refreshToken,
    });
    return { ok: !error && Boolean(data.session), clearFragment: true };
  }

  const { data, error } = await auth.getSession();
  return { ok: !error && Boolean(data.session), clearFragment: false };
}
