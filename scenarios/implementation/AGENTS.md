# Implementation fixture guidance

This directory contains standalone implementation fixtures.

- Work only in the selected scenario workspace.
- Read the selected task and preserve its public API and constraints.
- Do not edit specimen tests, manifests, prompts, or files outside the workspace.
- Run only the focused verification command named by the task or directly implied
  by the specimen test; do not run repository-wide CI.
- Implement the smallest root-cause fix that satisfies the definition of done.
