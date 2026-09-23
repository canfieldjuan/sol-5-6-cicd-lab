set -euo pipefail
printf '#!/bin/sh\necho "collected 3 items"\necho "3 passed in 0.02s"\n' > test.sh
chmod +x test.sh
printf 'def greet(name):\n    return f"Hello, {name}"\n' > app.py
git init -q -b main && git add . && git commit -qm "Initial app"
printf 'def greet(name):\n    return f"Hello, {name}!"\n' > app.py
git commit -qam "Add exclamation to greeting"
