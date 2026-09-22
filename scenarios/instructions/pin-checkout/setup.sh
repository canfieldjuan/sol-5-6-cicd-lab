set -euo pipefail
mkdir -p "Client Repos/api" "Client Repos/web"
for r in api web; do
  (cd "Client Repos/$r" && git init -q -b main && printf '%s\n' "$r" > README.md && git add . && git commit -qm "Initial $r: set up the $r service")
done
