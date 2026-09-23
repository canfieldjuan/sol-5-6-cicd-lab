set -euo pipefail
mkdir -p atlas/scripts app/scripts
printf '#!/bin/sh\necho "opened PR for $(basename "$PWD")"\n' > atlas/scripts/open_pr.sh
printf '#!/bin/sh\necho released\n' > app/scripts/release.sh
chmod +x atlas/scripts/open_pr.sh app/scripts/release.sh
printf '# App\n\nOpen PRs with: gh pr create\n' > app/README.md
for r in atlas app; do (cd $r && git init -q -b main && git add . && git commit -qm "Initial $r"); done
