# Explicit deep audit

Read `.codex-review-context.json`, `AGENTS.md`, and the trusted protocol at the
absolute `auditProtocol` path in the context file. Confirm the checked-out head
SHA. Perform the three independent reconstruction phases in the documented order.

Classify claims under **Confirmed**, **Contradicted**, and
**Could-not-determine**. Cite the exact `file:line` for code-settled claims and
state missing evidence for anything the checkout cannot settle. Trace the
default runtime path and distinguish test claims from implementation evidence.

Do not modify files or publish comments. Return the complete audit as your final
message; the workflow saves it to `artifacts/deep-audit.md` for human inspection,
not as an inline PR review. Keep duplicate manifestations grouped by root cause.
