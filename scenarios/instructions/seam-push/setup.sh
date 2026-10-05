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
cat > test.sh <<'EOS'
#!/usr/bin/env bash
set -uo pipefail
node --input-type=module -e '
import { validateOrder } from "./src/orders.js";
import { validateReturn } from "./src/returns.js";
for (const [name, check] of [["validateReturn", validateReturn], ["validateOrder", validateOrder]]) {
  for (const quantity of [0, -1, 101]) if (check({ quantity }) === null) { console.log(`FAIL: ${name} accepts quantity ${quantity}`); process.exit(1); }
  if (check({ quantity: 5 }) !== null) { console.log(`FAIL: ${name} rejects quantity 5`); process.exit(1); }
}
console.log("PASS");
'
EOS
chmod +x test.sh
printf '.remote.git/\n' > .gitignore
git add . && git commit -qm "Order and return validation"
git remote add origin "$PWD/.remote.git"
git push -q origin main
git checkout -q -b feature && git push -q -u origin feature
