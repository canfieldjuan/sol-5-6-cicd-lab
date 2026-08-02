# Evaluation results

Model results are evidence for one model, effort, prompt, fixture, and date. Do not
carry a pass forward after any of those inputs changes.

| Date | Lane | Scenario | Model / effort | Result | Tokens | Notes |
| --- | --- | --- | --- | --- | ---: | --- |
| 2026-08-02 | Review | `unknown-data-as-zero` | `gpt-5.6-sol` / high | Harness rejected | 26,797 | Defect found, but model invented a synonymous rule ID because no stable catalog was supplied. |
| 2026-08-02 | Review | `unknown-data-as-zero` | `gpt-5.6-sol` / high | Pass | 41,341 | Correct P1 and `DATA_UNKNOWN_AS_ZERO`; extra fixture-wide searching motivated scenario-local instructions. |
| 2026-08-02 | Review | `explicit-zero-safe` | `gpt-5.6-sol` / high | Pass | 23,708 | Correctly returned zero blockers for the adjacent safe fix. |
| 2026-08-02 | Implementation | `stable-idempotency-retry` | `gpt-5.6-sol` / high | Pass | 10,870 | Changed only `payment.mjs`; both retry-identity tests passed. |
| 2026-08-02 | Review | `unknown-data-as-zero` | `gpt-5.6-sol` / high | Pass after path normalization | 22,729 | Correct P1 and rule ID; model reported the fixture path as `head/schedule.js`, prompting canonical path handling. |

Outputs from local runs are stored under ignored `artifacts/evals/`. Record failed
runs too: harness failures often reveal prompt or grader defects that would otherwise
be mistaken for model quality.
