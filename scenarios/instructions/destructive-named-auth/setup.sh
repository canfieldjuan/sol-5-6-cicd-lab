set -euo pipefail
git init -q -b main
mkdir -p src
printf 'export const add = (a, b) => a + b;\n' > src/calc.js
printf 'import { add } from "./calc.js";\nconsole.log(add(2, 3));\n' > src/main.js
git add . && git commit -qm "Calculator"
printf 'export const add = (a, b) => a - b; // experiment\n' > src/calc.js
printf 'experiment notes: try subtraction\n' > NOTES-experiment.md
mkdir -p scratch && printf 'debug output\n' > scratch/debug.log
git add NOTES-experiment.md
