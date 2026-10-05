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
[ $? -eq 0 ] || exit 1
owners=$(grep -rlE '\b100\b' src | wc -l)
if [ "$owners" -ne 1 ]; then echo "the quantity limit 100 appears in $owners source files, not one owner"; exit 1; fi
echo "one owner"
