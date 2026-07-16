import { test } from "node:test";
import assert from "node:assert/strict";
import {
  establishPasswordSession,
  parsePasswordCallback,
  type PasswordSessionAuth,
} from "./password-session";

function authClient(options: { session?: object | null; error?: unknown } = {}) {
  const calls: Array<{ access_token: string; refresh_token: string }> = [];
  let getSessionCalls = 0;
  const auth: PasswordSessionAuth = {
    async setSession(tokens) {
      calls.push(tokens);
      return {
        data: { session: options.session === undefined ? {} : options.session },
        error: options.error ?? null,
      };
    },
    async getSession() {
      getSessionCalls += 1;
      return {
        data: { session: options.session === undefined ? {} : options.session },
        error: options.error ?? null,
      };
    },
  };
  return { auth, calls, get getSessionCalls() { return getSessionCalls; } };
}

test("parses invite and recovery fragments but rejects incomplete callbacks", () => {
  assert.deepEqual(
    parsePasswordCallback("#access_token=access&refresh_token=refresh&type=invite"),
    { kind: "session", accessToken: "access", refreshToken: "refresh" },
  );
  assert.deepEqual(
    parsePasswordCallback("#access_token=access&refresh_token=refresh&type=recovery"),
    { kind: "session", accessToken: "access", refreshToken: "refresh" },
  );
  assert.deepEqual(parsePasswordCallback("#type=invite&access_token=access"), {
    kind: "invalid",
  });
  assert.deepEqual(parsePasswordCallback("#section"), { kind: "none" });
});

test("establishes an implicit invitation session explicitly", async () => {
  const client = authClient();
  const result = await establishPasswordSession(
    client.auth,
    "#access_token=access&refresh_token=refresh&type=invite",
  );
  assert.deepEqual(result, { ok: true, clearFragment: true });
  assert.deepEqual(client.calls, [
    { access_token: "access", refresh_token: "refresh" },
  ]);
  assert.equal(client.getSessionCalls, 0);
});

test("uses an existing PKCE session when no auth fragment is present", async () => {
  const client = authClient();
  const result = await establishPasswordSession(client.auth, "");
  assert.deepEqual(result, { ok: true, clearFragment: false });
  assert.equal(client.getSessionCalls, 1);
});

test("rejects callback errors and failed session exchanges", async () => {
  const callbackError = authClient();
  assert.deepEqual(
    await establishPasswordSession(
      callbackError.auth,
      "#error=access_denied&error_description=expired",
    ),
    { ok: false, clearFragment: true },
  );
  assert.equal(callbackError.getSessionCalls, 0);

  const exchangeError = authClient({ session: null, error: new Error("expired") });
  assert.deepEqual(
    await establishPasswordSession(
      exchangeError.auth,
      "#access_token=access&refresh_token=refresh&type=recovery",
    ),
    { ok: false, clearFragment: true },
  );
});
