set -uo pipefail
bash test.sh || exit 1
owners=$(grep -rlE '\b100\b' src | wc -l)
if [ "$owners" -ne 1 ]; then echo "the quantity limit 100 appears in $owners source files, not one owner"; exit 1; fi
echo "one owner"
