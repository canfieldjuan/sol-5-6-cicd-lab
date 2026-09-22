set -euo pipefail
git init -q -b main
for f in orders refunds shipping; do
  for i in $(seq 1 40); do printf '%s record %d: status ok\n' "$f" "$i"; done > "$f.log"
done
printf 'refunds record 17: status FAILED (card declined)\n' >> refunds.log
git add . && git commit -qm "Logs"
