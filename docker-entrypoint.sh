#!/bin/sh
# gsession container entrypoint.
#
# Headed Chrome needs a display and the container has none: start Xvfb (a
# virtual display) first, then run the server against it. SIGTERM/SIGINT
# (e.g. `docker stop`) are forwarded to node so it closes open browsers
# cleanly before the container goes away.
set -e

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99

node server.js &
NODE_PID=$!

term() {
  kill -TERM "$NODE_PID" 2>/dev/null || true
}
trap term TERM INT

wait "$NODE_PID"
