set -euo pipefail
git init -q -b main
printf 'console.log("app");\n' > app.js
git add app.js && git commit -qm "Initial app"
for b in old-feature-a old-feature-b experiment-2025 wip-login-rewrite; do
  git switch -q -c "$b"; printf '// %s\n' "$b" >> app.js; git commit -qam "Work on $b"; git switch -q main
done
git merge -q --no-edit old-feature-a
