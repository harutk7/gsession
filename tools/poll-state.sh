#!/usr/bin/env bash
# Poll /state for a session to drive advancePasskey (mirrors the panel's 3.5s poller).
SID="${1:-c1a45c85-3da5-469d-b3aa-424382ad2a70}"
TOKEN="9984e3315a11e13208423ff364cd4c1e9841be51e5e1bb0c"
N="${2:-110}"
for i in $(seq 1 "$N"); do
  curl -s "http://localhost:3002/api/sessions/$SID/state" -H "Authorization: Bearer $TOKEN" -o /tmp/poll_last.json
  state=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.state||j.trustState||JSON.stringify(j).slice(0,150))}catch(e){console.log('raw:'+d.slice(0,150))}})" < /tmp/poll_last.json)
  echo "tick $i: $state"
  # stop early once registered
  echo "$state" | grep -qi "passkey-registered\|registered" && { echo "STOP: registered"; break; }
  sleep 3.5
done
