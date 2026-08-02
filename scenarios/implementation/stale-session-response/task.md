# Task

Fix `workspace/controller.mjs` so an in-flight request from an ended session
cannot restore private data after logout. Keep the exported API unchanged. Do
not edit the specimen test.

## Definition of done

- The supplied normal-path and stale-response tests pass.
- Only `controller.mjs` changes.
- Logout clears visible data immediately.
