# Deep Audit Protocol

Use this protocol only when the user or workflow explicitly requests a deep audit.

## Reconstruction

1. Read only the exact base-to-head diff and record what each hunk changes.
2. From the problem and base code, derive the independent correct-fix contract.
3. Compare diff behavior, required behavior, and claimed behavior.
4. Trace relevant callers, consumers, defaults, retries, failures, and recovery paths.

## Evidence buckets

### Confirmed

Every item needs an exact code location and must state trigger, impact, and why existing
guards or tests do not prevent it.

### Contradicted

Record important proposed findings or claims disproved by the code, with the location
that disproves them.

### Could-not-determine

Record claims that require unavailable deployment, environment, or external-service
evidence. State the missing evidence.

## Output

Write one versioned Markdown or JSON artifact. Do not automatically turn the complete
artifact into inline review comments. The routine-review policy decides what blocks a
pull request.
