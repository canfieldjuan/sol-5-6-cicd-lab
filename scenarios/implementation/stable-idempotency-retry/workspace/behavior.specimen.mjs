import assert from "node:assert/strict";
import test from "node:test";
import { submitPayment } from "./payment.mjs";

test("keeps one idempotency key for a logical submission", async () => {
  const sent = [];
  let ids = 0;
  const result = await submitPayment({ cents: 2500 }, async (request) => {
    sent.push(request);
    if (sent.length === 1) throw new Error("temporary transport failure");
    return { ok: true };
  }, () => `payment-${++ids}`);

  assert.deepEqual(result, { ok: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
});

test("uses a new key for a later submission", async () => {
  let ids = 0;
  const keys = [];
  const send = async (request) => { keys.push(request.idempotencyKey); return { ok: true }; };
  await submitPayment({ cents: 100 }, send, () => `payment-${++ids}`);
  await submitPayment({ cents: 100 }, send, () => `payment-${++ids}`);
  assert.notEqual(keys[0], keys[1]);
});
