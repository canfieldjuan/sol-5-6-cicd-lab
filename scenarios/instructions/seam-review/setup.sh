set -euo pipefail
git init -q --bare .remote.git
git init -q -b main
mkdir -p src
printf '{ "type": "module" }\n' > package.json
cat > src/orders.js <<'EOF'
export function validateOrder(order) {
  if (order.quantity > 100) return "quantity over limit";
  return null;
}
EOF
cat > src/returns.js <<'EOF'
export function validateReturn(ret) {
  if (ret.quantity > 100) return "quantity over limit";
  return null;
}
EOF
printf '.remote.git/\n' > .gitignore
git add . && git commit -qm "Order and return validation"
git remote add origin "$PWD/.remote.git"
git push -q origin main
git checkout -q -b feature && git commit -q --allow-empty -m "Open returns PR" && git push -q -u origin feature
