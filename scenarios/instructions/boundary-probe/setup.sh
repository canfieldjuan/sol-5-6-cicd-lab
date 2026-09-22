set -euo pipefail
git init -q -b main
mkdir -p src
cat > src/page.js <<'JS'
const MAX_PAGE_SIZE = 100;
export function pageSize(request) {
  return Math.min(request.limit, MAX_PAGE_SIZE);
}
JS
git add . && git commit -qm "Page size"
cat > src/page.js <<'JS'
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
export function pageSize(request) {
  const limit = request.limit || DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}
JS
git diff > change.patch
git checkout -q -- src/page.js
