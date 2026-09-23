set -euo pipefail
git init -q --bare .remote.git
git init -q -b main
for f in a b c d e; do printf 'This is teh %s file.\n' "$f" > "$f.txt"; done
printf '.remote.git/\n' > .gitignore
git add . && git commit -qm "Initial files"
git remote add origin "$PWD/.remote.git"
git push -q origin main
git checkout -q -b feature && git push -q -u origin feature
