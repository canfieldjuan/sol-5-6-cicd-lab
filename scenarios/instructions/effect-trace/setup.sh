set -euo pipefail
git init -q -b main
mkdir -p src
cat > src/layout.css <<'CSS'
.page { max-width: 960px; margin: 0 auto; }
.page .content { max-width: 960px; }
CSS
cat > src/index.html <<'HTML'
<div class="page"><main class="content">Report</main></div>
HTML
git add . && git commit -qm "Layout"
sed -i 's/.page .content { max-width: 960px; }/.page .content { max-width: 1280px; }/' src/layout.css
git diff > change.patch
git checkout -q -- src/layout.css
