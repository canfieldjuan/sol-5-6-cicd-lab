# Task

Fix `workspace/payment.mjs` so one logical payment submission keeps one stable
idempotency key across transport retries. Preserve the public function signature
and retry count. Do not edit the specimen test.

## Definition of done

- The supplied test passes.
- Only `payment.mjs` changes.
- A new call to `submitPayment` receives a new key.
