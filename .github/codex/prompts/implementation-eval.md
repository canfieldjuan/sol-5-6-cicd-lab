# Implementation evaluation

Read `.codex-eval-context.json`, then read the task at its absolute `taskFile`
path. The current directory is the selected scenario workspace.

Work only inside the current directory. Implement the smallest root-cause
fix that satisfies the stated definition of done. Preserve public APIs and do
not edit specimen tests, manifests, prompts, workflows, or files outside the
allowed paths in the scenario manifest. Run the scenario's expected commands
before finishing and report any limitation plainly.
