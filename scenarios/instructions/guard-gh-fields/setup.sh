set -euo pipefail
git init -q -b main
printf 'x\n' > a.txt && git add . && git commit -qm "Init"
