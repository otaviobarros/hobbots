#!/usr/bin/env bash
# Smoke-tests a packaged Hobbots.app: launches it as the hub with the fake runtime, waits for its server's
# health check and for the memory engine it runs, kills the engine to check it is started again, then
# quits the app and checks that the server and the engine it launched stopped too.
#
#   apps/desktop/scripts/smoke-test.sh path/to/Hobbots.app [extra app arguments]
#
# On a Mac with Hobbots data, pass --user-data-dir=<empty folder> to keep the test out of it.
# HOBBOTS_PORT picks the port (default 4317) and SMOKE_TIMEOUT the seconds to wait (default 60).
set -euo pipefail

app="${1:?usage: smoke-test.sh path/to/Hobbots.app [extra app arguments]}"
shift
port="${HOBBOTS_PORT:-4317}"
timeout="${SMOKE_TIMEOUT:-60}"
health="http://127.0.0.1:${port}/api/health"

# The app attaches to a server already on its port, which would test that server instead.
if curl -fsS --max-time 1 "$health" >/dev/null 2>&1; then
  echo "A server already answers on port ${port}; stop it or set HOBBOTS_PORT." >&2
  exit 1
fi

# A new data folder starts setup with no server (ADR 025); HOBBOTS_MODE=hub makes it the hub, as Run here does.
HOBBOTS_RUNTIME=fake HOBBOTS_MODE=hub HOBBOTS_PORT="$port" "${app}/Contents/MacOS/Hobbots" "$@" &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT

deadline=$((SECONDS + timeout))
until curl -fsS --max-time 1 "$health" >/dev/null 2>&1; do
  if ! kill -0 "$pid" 2>/dev/null; then
    code=0
    wait "$pid" || code=$?
    echo "Hobbots exited with code ${code} before its server answered." >&2
    exit 1
  fi
  if ((SECONDS >= deadline)); then
    echo "Hobbots did not answer on ${health} within ${timeout}s." >&2
    exit 1
  fi
  sleep 0.5
done
echo "Hobbots answered on ${health}."

# The bundled memory engine (ADR 028): the hub starts it once its checksum matches, and starts it
# again after a crash.
engine="${app}/Contents/Resources/memory/ai-memory serve"
engine_pid() { pgrep -f "$engine" | head -n 1; }
wait_for_engine() {
  local not="$1" deadline=$((SECONDS + 30)) found
  while :; do
    found="$(engine_pid || true)"
    if [[ -n "$found" && "$found" != "$not" ]]; then
      echo "$found"
      return
    fi
    if ((SECONDS >= deadline)); then
      echo "The memory engine did not start within 30s." >&2
      exit 1
    fi
    sleep 0.5
  done
}
first="$(wait_for_engine none)"
echo "The memory engine runs (pid ${first})."
kill -KILL "$first"
second="$(wait_for_engine "$first")"
echo "The memory engine was started again after a crash (pid ${second})."

# Electron quits gracefully on SIGTERM, which runs the app's before-quit handler.
kill -TERM "$pid"
deadline=$((SECONDS + 15))
while kill -0 "$pid" 2>/dev/null; do
  if ((SECONDS >= deadline)); then
    echo "Hobbots did not quit within 15s." >&2
    exit 1
  fi
  sleep 0.5
done
trap - EXIT

# The server the app launched must stop with it.
deadline=$((SECONDS + 10))
while curl -fsS --max-time 1 "$health" >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo "The server Hobbots launched kept running after it quit." >&2
    exit 1
  fi
  sleep 0.5
done
echo "Hobbots quit and its server stopped."

deadline=$((SECONDS + 10))
while [[ -n "$(engine_pid || true)" ]]; do
  if ((SECONDS >= deadline)); then
    echo "The memory engine Hobbots started kept running after it quit." >&2
    exit 1
  fi
  sleep 0.5
done
echo "The memory engine stopped with it."
