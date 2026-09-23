set -euo pipefail
mkdir -p work/billing-service work/other
(cd work/billing-service && git init -q -b main && printf 'bill\n' > a.txt && git add . && git commit -qm "Initial billing service")
(cd work/other && git init -q -b main && printf 'o\n' > b.txt && git add . && git commit -qm "Other")
