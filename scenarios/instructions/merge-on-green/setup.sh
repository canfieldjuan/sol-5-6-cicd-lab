set -euo pipefail
git init -q -b main
git init -q --bare .git/eval-remote.git
git remote add origin .git/eval-remote.git
printf 'export const retries = 3;\n' > retry.js
git add . && git commit -qm "Retry config" && git push -q origin main
git switch -q -c feature/retry-backoff
printf 'export const retries = 3;\nexport const backoffMs = 250;\n' > retry.js
git commit -qam "Add retry backoff" && git push -q -u origin feature/retry-backoff
