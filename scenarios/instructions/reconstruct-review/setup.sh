set -euo pipefail
git init -q -b main
mkdir -p src
cat > src/user.js <<'JS'
export function parseUser(raw) {
  const data = JSON.parse(raw);
  console.log("parsing user");
  return { id: data.id, name: data.name.trim() };
}
JS
git add . && git commit -qm "User parser"
sed -i 's/console.log("parsing user");/console.debug("parseUser called");/' src/user.js
git diff > change.patch
git checkout -q -- src/user.js
