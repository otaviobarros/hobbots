#!/usr/bin/env bash
# Smoke-tests a packaged Hobbots.app: launches it with the fake runtime, waits for its server's
# health check, then quits it and checks that the server it launched stopped too.
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

HOBBOTS_RUNTIME=fake HOBBOTS_PORT="$port" "${app}/Contents/MacOS/Hobbots" "$@" &
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
