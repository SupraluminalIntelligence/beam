#!/usr/bin/env bash
# The heated-channel study as Beam runs it: mesh, then solve on that mesh, with beam-recipe. Leaves the
# solve's results in beam/out for check_results.py.
set -euo pipefail
cd "${BEAM_WORK:-$PWD}"
config='{"version":1,"geometry":"channel","length":0.2,"height":0.01,"nx":60,"ny":20,"velocity":0.02,"nu":1e-6,"pr":7,"density":998,"inletTemperature":293.15,"wallTemperature":313.15,"thermal":true,"iterations":800}'
mkdir -p beam
echo "{\"caseId\":\"benchmark\",\"revision\":1,\"stage\":\"mesh\",\"config\":$config}" > beam/recipe.json
beam-recipe
mv beam/out mesh-results && cp mesh-results/recipe/mesh.json mesh-input.json
echo "{\"caseId\":\"benchmark\",\"revision\":1,\"stage\":\"solve\",\"meshJobId\":\"mesh\",\"config\":$config}" > beam/recipe.json
beam-recipe
