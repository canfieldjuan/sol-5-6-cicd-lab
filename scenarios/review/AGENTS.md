# Review fixture guidance

This directory contains standalone review fixtures, not an installable repository.

- Use only the selected scenario's context, task, patch, base, head, rule catalog,
  and supplied output schema.
- Do not search parent directories, read `scenario.json`, or run repository-wide
  install, test, lint, or CI commands.
- Direct behavior probes are allowed when the fixture's language runtime is
  available.
- Report finding paths relative to `head/`, without prefixing them with `head/`.
- Report only proven P0/P1 blockers, with at most five distinct root causes.
- Use a matching stable catalog ID and group duplicate manifestations.
- Return `pass` when no P0/P1 defect is proven.
