import test from "node:test";
import assert from "node:assert/strict";
import { redactForReasoning } from "./reasoning-provider";

test("optional reasoning calls redact customer identifiers and access data", () => {
  const redacted = redactForReasoning(
    "Email me at jane@example.com, call +31 6 1234 5678, booking DTH-2607-10001, access code: 7812, address: Main Street 12 Amsterdam.",
  );
  assert.doesNotMatch(redacted, /jane@example\.com|\+31 6 1234 5678|DTH-2607-10001|7812|Main Street 12/i);
  assert.match(redacted, /\[email\]|\[phone-or-number\]|\[booking-reference\]|\[access-code\]|\[address\]/);
});
