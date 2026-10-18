#!/usr/bin/env bash
# Parity run for the JavaScript text front-end: corpus -> Python reference -> check of docs/js/front-native.js.
#   bash tools/parity/run.sh DIR [FUZZ_N] [SEED]
# The reference comes from Pyodide (what the site runs; PYODIDE_DIR, default the scratchpad's node_modules/pyodide),
# because CPython 3.13 differs from it (Unicode 15.1 vs 15.0). REF=cpython uses reference.py with $PYTHON instead
# (python3.12 has Pyodide's Unicode and gave the same results, five times faster). MAX_EXAMPLES (default 5) goes to
# check.mjs. Only check.mjs needs re-running after a change to the JS port. Exit status: check.mjs's.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: bash $0 DIR [FUZZ_N] [SEED]" >&2
  exit 2
fi
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dir=$1
fuzz=${2:-0}
seed=${3:-1}

python3 "$here/corpus.py" --out "$dir" --fuzz "$fuzz" --seed "$seed"
case "${REF:-pyodide}" in
  pyodide) node "$here/pyodide_ref.mjs" "$dir" --out ref.jsonl ;;
  cpython) "${PYTHON:-python3}" "$here/reference.py" "$dir" --out ref.jsonl ;;
  *) echo "REF must be pyodide or cpython" >&2; exit 2 ;;
esac
node "$here/check.mjs" "$dir" --max-examples "${MAX_EXAMPLES:-5}"
