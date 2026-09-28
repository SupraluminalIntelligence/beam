#!/usr/bin/env bash
# Spike: run the fea environment in local Docker and measure start-up, command round trips and
# the cantilever benchmark. Usage: environments/spike/local_spike.sh <image> <platform> <outdir>
set -euo pipefail
IMAGE=$1 PLATFORM=${2:-linux/arm64} OUT=${3:-/tmp/beam-spike}
mkdir -p "$OUT"
now() { python3 -c 'import time; print(time.time())'; }
since() { python3 -c "import sys; print(round($(now) - $1, 2))"; }

t=$(now); docker run --rm --platform "$PLATFORM" "$IMAGE" true; echo "cold container start: $(since "$t") s"

name=beam-spike-$$
docker run -d --rm --name "$name" --platform "$PLATFORM" --network none --shm-size=1g "$IMAGE" sleep 3600 > /dev/null
trap 'docker rm -f "$name" > /dev/null 2>&1 || true' EXIT
python3 - "$name" <<'PY'
import statistics, subprocess, sys, time
name = sys.argv[1]
trips = []
for _ in range(15):
    t = time.perf_counter(); subprocess.run(["docker", "exec", name, "true"], check=True); trips.append(time.perf_counter() - t)
print(f"docker exec round trip: median {statistics.median(trips)*1000:.0f} ms, max {max(trips)*1000:.0f} ms")
PY

run() {
  local label=$1; shift
  local t; t=$(now)
  docker exec -e BEAM_IMAGE="$IMAGE" -e BEAM_COMMAND="$*" "$name" bash -lc "rm -rf beam && $*" > "$OUT/$label.log" 2>&1
  echo "$label: $(since "$t") s"
  docker exec "$name" cat beam/out/manifest.json > "$OUT/$label.manifest.json"
}
run small-1rank  python /beam/benchmarks/cantilever.py
run small-4rank  mpirun -n 4 python /beam/benchmarks/cantilever.py
if [[ "$PLATFORM" == "linux/arm64" ]]; then
  run large-1rank mpirun -n 1 python /beam/benchmarks/cantilever.py --nx 120 --solver cg
  run large-8rank mpirun -n 8 python /beam/benchmarks/cantilever.py --nx 120 --solver cg
fi
docker exec "$name" bash -lc 'du -sh beam/out; ls -R beam/out | head -30' > "$OUT/outputs.txt"
