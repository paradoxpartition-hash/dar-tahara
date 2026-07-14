import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRefundRequest } from "./refunds";

const paidCtx = { paidCents: 11_900, paymentStatus: "paid", paymentIntentId: "pi_123" };

test("full refund is valid on a paid payment", () => {
  const r = validateRefundRequest({}, paidCtx);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.amountCents, undefined);
});

test("partial refund within the paid amount is valid", () => {
  const r = validateRefundRequest({ amountCents: 5000, reason: "requested_by_customer", note: " goodwill " }, paidCtx);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.amountCents, 5000);
    assert.equal(r.value.reason, "requested_by_customer");
    assert.equal(r.value.note, "goodwill");
  }
});

test("refund rejected when payment is not refundable", () => {
  assert.deepEqual(validateRefundRequest({}, { ...paidCtx, paymentStatus: "unpaid" }), { ok: false, error: "not_refundable" });
  assert.deepEqual(validateRefundRequest({}, { ...paidCtx, paymentIntentId: null }), { ok: false, error: "not_refundable" });
});

test("partially_refunded payments can still be refunded", () => {
  assert.ok(validateRefundRequest({ amountCents: 100 }, { ...paidCtx, paymentStatus: "partially_refunded" }).ok);
});

test("manipulated amounts are rejected", () => {
  assert.equal(validateRefundRequest({ amountCents: 999_999 }, paidCtx).ok, false); // over paid
  assert.equal(validateRefundRequest({ amountCents: 0 }, paidCtx).ok, false);
  assert.equal(validateRefundRequest({ amountCents: -100 }, paidCtx).ok, false);
  assert.equal(validateRefundRequest({ amountCents: 12.5 }, paidCtx).ok, false); // non-integer cents
});

test("unknown reason is dropped, not rejected", () => {
  const r = validateRefundRequest({ reason: "because" }, paidCtx);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.reason, undefined);
});
