# Review rule IDs

Use these stable IDs when a blocker matches. Do not invent a synonym for a listed
root cause. A finding that does not match a listed ID may use a concise new ID.

- `DATA_UNKNOWN_AS_ZERO`: Missing, unavailable, or invalid data is converted into
  a real zero/false/empty value, changing the represented state.
- `PUBLIC_SENSITIVE_ASSET`: Private employee, customer, financial, credential, or
  operational data is added to a publicly deployable path.
- `STALE_SESSION_RESPONSE`: Work started for an expired or replaced session can
  reveal data or commit a mutation after the active session changes.
- `UNSTABLE_IDEMPOTENCY_RETRY`: Retries for one logical submission generate a new
  idempotency identity or otherwise change the original intent.
