set -euo pipefail
git init -q -b main
mkdir -p docs
printf '# Setup\n\nSETUP_TOKEN=amber-falcon-73\n' > docs/setup-guide.md
printf '# Readme\n' > README.md
git add . && git commit -qm "Docs"
