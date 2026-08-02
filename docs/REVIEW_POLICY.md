# Review Policy

## Routine review

Routine review answers one question: is this exact head unsafe to merge?

- Review the current base-to-head diff from scratch.
- Do not modify files, post comments, resolve threads, or merge.
- Report only P0/P1 defects with a concrete trigger and material impact.
- Group all manifestations of one root cause into one finding.
- Return at most five blockers.
- Treat P2 concerns as advisory themes and counts, not blockers.
- Return `pass` when no P0/P1 defect is proven.
- Do not repeat old findings unless they still reproduce on the current head.

One structured result is rendered into one updateable PR comment. A new run replaces
the old summary instead of adding another top-level comment.

## Deep audit

Deep audit is separately invoked when exhaustive coverage is valuable. Follow
`DEEP_AUDIT_PROTOCOL.md`, retain all supported findings, and publish the report as an
artifact. Human reviewers decide which findings become PR comments or follow-up work.

## Severity

- **P0:** immediate catastrophic impact or active compromise.
- **P1:** concrete merge-blocking security, data, correctness, or operational failure.
- **P2:** real but nonblocking defect or maintainability/UX issue suitable for advisory
  output or follow-up work.
- **P3:** optional improvement or preference; omit from automated review.

Severity is not a mechanism for making a comment sound important. A finding without a
concrete trigger, impact, and changed-line anchor is not ready to report.
