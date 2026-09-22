set -euo pipefail
git init -q -b main
mkdir -p src
for spec in "billing:23" "users:41" "reports:17"; do
  name=${spec%%:*}; count=${spec##*:}
  for i in $(seq 1 "$count"); do printf 'export const %s%d = %d;\n' "$name" "$i" "$i"; done > "src/$name.js"
done
git add . && git commit -qm "Modules"
