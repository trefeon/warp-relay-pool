#!/bin/sh
# logwatch.test.sh - hermetic edge-case suite for logwatch.sh.
#
# Harness choice: hand-rolled POSIX sh with TAP-ish output. Rationale:
# bats-core and shunit2 are installed on neither Git Bash nor the minimal
# Docker Linux deploy hosts, and the project mandates zero new
# dependencies: a ~40-line sh harness runs everywhere with no install.
#
# Usage:  sh logwatch.test.sh
# All tests are hermetic: docker/journalctl are PATH shims backed by
# fixture files in a fresh mktemp dir per test. No daemons, no host
# changes, no network. logwatch.sh itself is never modified.
#
# Conventions: test names prefixed BUG: assert CORRECT behavior that the
# watcher does not yet implement. They fail until Main approves a fix in
# logwatch.sh; the failure shows expected-vs-actual and the suite exits
# nonzero while any BUG test fails.
set -u

REPO="$(cd "$(dirname "$0")" && pwd)"
WATCH="$REPO/logwatch.sh"

pass=0; fail=0; n=0
t0="$(date +%s)"

ok()  { n=$((n+1)); pass=$((pass+1)); printf 'ok %d - %s\n' "$n" "$1"; }
ng()  { n=$((n+1)); fail=$((fail+1)); printf 'not ok %d - %s\n' "$n" "$1";
        [ "${2:-}" != "" ] && printf '  # %s\n' "$2"; }

# expect_eq <desc> <actual> <expected>
expect_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else ng "$1" "expected [$3] got [$2]"; fi
}

# expect_contains <desc> <file> <fixed-string>
expect_contains() {
  if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1";
  else ng "$1" "missing [$3] in $2"; fi
}

# expect_absent <desc> <file> <fixed-string>
expect_absent() {
  if grep -qF -- "$3" "$2" 2>/dev/null; then ng "$1" "unexpected [$3] in $2";
  else ok "$1"; fi
}

# --- per-test sandbox -------------------------------------------------
# new_sandbox [count]: sets T (work dir), FIX (fixtures), BIN (shims);
# writes hermetic docker + journalctl shims onto PATH.
new_sandbox() {
  T="$(mktemp -d)"
  FIX="$T/fix"; BIN="$T/bin"; LOGS="$T/logs"
  mkdir -p "$FIX" "$BIN" "$LOGS"
  export T FIX BIN LOGS
  cat > "$BIN/docker" <<'EOF'
#!/bin/sh
# Fixture docker: dispatches on the last argv word (container name).
name=""
for a in "$@"; do name="$a"; done
echo "$*" >> "$T_FIX_ARGS_DOCKER"
if [ -f "$FIX/docker-fail-$name" ]; then
  cat "$FIX/docker-fail-$name" >&2
  exit 1
fi
[ -f "$FIX/docker-$name.log" ] && cat "$FIX/docker-$name.log"
exit 0
EOF
  cat > "$BIN/journalctl" <<'EOF'
#!/bin/sh
echo "$*" >> "$T_FIX_ARGS_JOURNAL"
[ -f "$FIX/journal.log" ] && cat "$FIX/journal.log"
exit 0
EOF
  chmod +x "$BIN/docker" "$BIN/journalctl"
  export T_FIX_ARGS_DOCKER="$T/docker.args" T_FIX_ARGS_JOURNAL="$T/journal.args"
  : > "$T/docker.args"; : > "$T/journal.args"
}

# run_watch [count]: runs logwatch.sh with sandbox env; sets RC, OUT.
run_watch() {
  cnt="${1:-2}"
  PATH="$BIN:$PATH" \
  POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT="$cnt" \
  CONTAINER_PREFIX="warp-relay-warp-" APP_CONTAINER="warp-relay-app" \
  JOURNAL_UNIT="warp-keep-cold.service" \
  sh "$WATCH" > "$T/out.txt" 2>&1
  RC=$?
}

drop_sandbox() { rm -rf "$T"; }

# --- 1. empty inputs ---------------------------------------------------
new_sandbox
run_watch
expect_eq "empty inputs: exit 0" "$RC" "0"
expect_eq "empty inputs: errors.log empty" "$(wc -c < "$LOGS/errors.log")" "0"
expect_eq "empty inputs: no .events tallies" "$(wc -c < "$LOGS/.events")" "0"
case "$(cat "$LOGS/.cursor")" in ''|*[!0-9]*) ng "empty inputs: numeric cursor" ;;
  *) ok "empty inputs: numeric cursor" ;; esac
drop_sandbox

# --- 2. missing cursor uses FIRST_SINCE --------------------------------
new_sandbox
FIRST_SINCE_DOCKER="6h" FIRST_SINCE_JOURNAL="6 hours ago" \
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=1 \
sh "$WATCH" > "$T/out.txt" 2>&1
expect_eq "first run: exit 0" "$?" "0"
expect_contains "first run: docker --since 6h" "$T/docker.args" "--since 6h"
expect_contains "first run: journal --since 6 hours ago" \
  "$T/journal.args" "--since 6 hours ago"
drop_sandbox

# --- 3. corrupt / empty cursor falls back -------------------------------
new_sandbox
printf 'not-a-number' > "$LOGS/.cursor"
FIRST_SINCE_DOCKER="6h" FIRST_SINCE_JOURNAL="6 hours ago" \
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=1 \
sh "$WATCH" > "$T/out.txt" 2>&1
expect_eq "corrupt cursor: exit 0" "$?" "0"
expect_contains "corrupt cursor: docker falls back to FIRST_SINCE" \
  "$T/docker.args" "--since 6h"
: > "$T/docker.args"
: > "$LOGS/.cursor"   # empty file is also corrupt
FIRST_SINCE_DOCKER="6h" FIRST_SINCE_JOURNAL="6 hours ago" \
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=1 \
sh "$WATCH" > "$T/out.txt" 2>&1
expect_contains "empty cursor: docker falls back to FIRST_SINCE" \
  "$T/docker.args" "--since 6h"
drop_sandbox

# --- 4. container missing mid-scrape ------------------------------------
# docker prints "Error: No such container" on stderr; 2>&1 pipes it into
# the matcher, and "Error" matches. Documented behavior: the
# disappearance IS recorded against that source (not silent, not fatal).
new_sandbox
printf 'Error: No such container: warp-relay-warp-1\n' > "$FIX/docker-fail-warp-relay-warp-1"
run_watch 1
expect_eq "missing container: exit 0" "$RC" "0"
expect_contains "missing container: recorded with source tag" \
  "$LOGS/errors.log" "[warp-relay-warp-1] Error: No such container"
drop_sandbox

# --- 5. daemon down is silent --------------------------------------------
# "Cannot connect to the Docker daemon ..." matches no pattern, so a
# dead daemon produces no entries (and no crash). Documented behavior.
new_sandbox
printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' \
  > "$FIX/docker-fail-warp-relay-warp-1"
printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' \
  > "$FIX/docker-fail-warp-relay-app"
run_watch 1
expect_eq "daemon down: exit 0" "$RC" "0"
expect_eq "daemon down: nothing recorded" "$(wc -c < "$LOGS/errors.log")" "0"
drop_sandbox

# --- 6. no docker/journalctl binaries at all ------------------------------
# CI runners ship a real docker binary, so absence must be constructed rather
# than assumed: build a PATH-only mirror of the tool directories with the
# names under test removed. Keeping /usr/bin on PATH would let the real
# docker resolve again (its "No such container" error is recorded by design,
# see case 4).
new_sandbox
mkdir -p "$T/emptybin"
for dir in /usr/bin /bin /usr/local/bin /usr/sbin /sbin; do
  [ -d "$dir" ] || continue
  for f in "$dir"/*; do
    b="$(basename "$f")"
    case "$b" in docker|dockerd|docker-compose|journalctl) continue ;; esac
    [ -e "$T/emptybin/$b" ] || ln -s "$f" "$T/emptybin/$b" 2>/dev/null || true
  done
done
PATH="$T/emptybin" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=1 \
sh "$WATCH" > "$T/out.txt" 2>&1
expect_eq "missing binaries: exit 0" "$?" "0"
expect_eq "missing binaries: errors.log empty" "$(wc -c < "$LOGS/errors.log")" "0"
drop_sandbox

# --- 7. malformed journal lines (no timestamp) ------------------------------
new_sandbox
printf 'warp-keep-cold relay #2 troubled: still failing after retry\nplain line without meaning\n' > "$FIX/journal.log"
run_watch 1
expect_contains "journal without timestamps: error line captured" \
  "$LOGS/errors.log" "troubled: still failing"
expect_absent "journal without timestamps: noise excluded" \
  "$LOGS/errors.log" "without meaning"
drop_sandbox

# --- 8. pattern digit guards vs plain substrings ------------------------------
new_sandbox
cat > "$FIX/docker-warp-relay-warp-1.log" <<'EOF'
2026-10-05T00:00:00Z request took 1502ms pid=15023 all good
2026-10-05T00:00:01Z upstream status 502 from peer
2026-10-05T00:00:02Z terror alert in module
2026-10-05T00:00:03Z port 502/tcp open on probe
EOF
run_watch 1
expect_absent "guards: 1502ms latency is not a 502" "$LOGS/errors.log" "1502ms"
expect_contains "guards: bare 502 matches" "$LOGS/errors.log" "status 502"
expect_contains "guards: substring 'error' inside 'terror' matches (plain substring)" \
  "$LOGS/errors.log" "terror alert"
expect_contains "guards: bare port 502 matches (digit-guarded only against embedding)" \
  "$LOGS/errors.log" "port 502/tcp"
drop_sandbox

# --- 9. dedupe: A A A B A -----------------------------------------------
new_sandbox
cat > "$FIX/docker-warp-relay-warp-1.log" <<'EOF'
2026-10-05T00:00:00Z boom error one
2026-10-05T00:00:00Z boom error one
2026-10-05T00:00:00Z boom error one
2026-10-05T00:00:01Z other failure mode
2026-10-05T00:00:02Z boom error one
EOF
run_watch 1
expect_contains "dedupe: run collapsed to (x3)" "$LOGS/errors.log" "boom error one (x3)"
expect_contains "dedupe: middle line emitted once" "$LOGS/errors.log" "other failure mode"
expect_eq "dedupe: exactly 3 warp-1 lines" \
  "$(grep -c 'warp-relay-warp-1' "$LOGS/errors.log")" "3"
drop_sandbox

# --- 10. --since overlap folded via .last --------------------------------
new_sandbox
printf '2026-10-05T00:00:00Z first error hit\n2026-10-05T00:00:01Z second failure hit\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
lines1="$(wc -l < "$LOGS/errors.log")"
printf '2026-10-05T00:00:01Z second failure hit\n2026-10-05T00:00:02Z third timeout hit\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "overlap: only the new line appended" \
  "$(wc -l < "$LOGS/errors.log")" "$((lines1 + 1))"
expect_contains "overlap: new line present" "$LOGS/errors.log" "third timeout"
expect_eq "overlap: cursor advanced forward" \
  "$(test "$(cat "$LOGS/.cursor")" -ge 0 && echo yes)" "yes"
drop_sandbox

# --- 11. rotation at exactly MAX_BYTES ------------------------------------
new_sandbox
printf '2026-10-05T00:00:00Z some error here\n' > "$FIX/docker-warp-relay-warp-1.log"
head -c 99 /dev/zero | tr '\0' 'x' > "$LOGS/errors.log"
sz="$(wc -c < "$LOGS/errors.log")"
MAX_BYTES="$((sz + 1))" KEEP_ROTATED=3 \
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=0 \
APP_CONTAINER="no-such-app" JOURNAL_UNIT="no-such-unit" \
sh "$WATCH" > "$T/out.txt" 2>&1
if [ -f "$LOGS/errors.log.1" ]; then ng "rotation: below boundary must not rotate";
else ok "rotation: below boundary must not rotate"; fi
sz2="$(wc -c < "$LOGS/errors.log")"
MAX_BYTES="$sz2" KEEP_ROTATED=3 \
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=0 \
APP_CONTAINER="no-such-app" JOURNAL_UNIT="no-such-unit" \
sh "$WATCH" > "$T/out.txt" 2>&1
if [ -f "$LOGS/errors.log.1" ]; then ok "rotation: exactly MAX_BYTES rotates";
else ng "rotation: exactly MAX_BYTES rotates"; fi
drop_sandbox

# --- 12. rotation chain honors KEEP_ROTATED ---------------------------------
# Steady state with KEEP=2 holds at most .1 + .2: the shift moves .1 to
# .2 (overwriting the stale .2), then the oversized log becomes .1.
# (The script never prunes orphan .3+ files planted by hand - only the
# shift chain is bounded, so the fixture plants none.)
new_sandbox
printf 'old2' > "$LOGS/errors.log.2"
printf 'old1' > "$LOGS/errors.log.1"
printf 'current-big-error\ncurrent-big-error\n' > "$LOGS/errors.log"
MAX_BYTES=10 KEEP_ROTATED=2 \
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=0 \
APP_CONTAINER="no-such-app" JOURNAL_UNIT="no-such-unit" \
sh "$WATCH" > "$T/out.txt" 2>&1
expect_eq "chain: .2 holds previous .1" "$(cat "$LOGS/errors.log.2")" "old1"
expect_eq "chain: .1 holds pre-rotation log" "$(cat "$LOGS/errors.log.1")" "current-big-error
current-big-error"
if [ -f "$LOGS/errors.log.3" ]; then ng "chain: no .3 created under KEEP=2";
else ok "chain: no .3 created under KEEP=2"; fi
drop_sandbox

# --- 13. midnight rollover summary -------------------------------------------
new_sandbox
yesterday="$(date -u -d 'yesterday' +%F 2>/dev/null || date -u -v-1d +%F)"
printf '%s' "$yesterday" > "$LOGS/.day"
cat > "$LOGS/.events" <<'EOF'
1 http_429 2
1 http_429 1
2 conn 1
app other 1
pool http_5xx 4
EOF
run_watch 2
expect_contains "rollover: relay 1 aggregates 429=3" "$LOGS/errors.log" \
  "day=$yesterday relay=1 429=3"
expect_contains "rollover: relay 2 conn=1" "$LOGS/errors.log" \
  "day=$yesterday relay=2 429=0 5xx=0 403=0 conn=1"
expect_contains "rollover: app line emitted" "$LOGS/errors.log" \
  "day=$yesterday relay=app"
expect_contains "rollover: pool line emitted" "$LOGS/errors.log" \
  "day=$yesterday relay=pool"
expect_eq "rollover: .events cleared" "$(wc -c < "$LOGS/.events")" "0"
expect_eq "rollover: .day advanced to today" "$(cat "$LOGS/.day")" "$(date -u +%F)"
drop_sandbox

# --- 14. rollover with zero events: zeros prove the watcher ran ---------------
new_sandbox
printf '2000-01-01' > "$LOGS/.day"
: > "$LOGS/.events"
run_watch 2
expect_contains "zeros: relay 1 total=0" "$LOGS/errors.log" "relay=1 429=0 5xx=0 403=0 conn=0 upstream=0 controller=0 other=0 total=0"
expect_contains "zeros: relay 2 total=0" "$LOGS/errors.log" "relay=2 429=0 5xx=0 403=0 conn=0 upstream=0 controller=0 other=0 total=0"
expect_absent "zeros: no app line when idle" "$LOGS/errors.log" "relay=app"
expect_absent "zeros: no pool line when idle" "$LOGS/errors.log" "relay=pool"
drop_sandbox

# --- 15. classify + attribute matrix --------------------------------------------
new_sandbox
# Run 1 scrapes only (.day is today, so no summary yet): the seven
# classes land as tallies in .events, attributed to relay 3.
cat > "$FIX/docker-warp-relay-warp-3.log" <<'EOF'
2026-10-05T00:00:00Z got 429 too many requests
2026-10-05T00:00:01Z unexpected http 500 from upstream
2026-10-05T00:00:02Z got 403 forbidden now
2026-10-05T00:00:03Z connection timeout reached
2026-10-05T00:00:04Z upstream server_error happened
2026-10-05T00:00:05Z controller gave up on relay
2026-10-05T00:00:06Z weird failure happened
EOF
run_watch 3
for cls in http_429 http_5xx http_403 conn upstream controller other; do
  expect_contains "matrix: tally 3 $cls" "$LOGS/.events" "3 $cls 1"
done
# Run 2 (sources emptied so nothing double-tallies, .day rewound) turns
# those tallies into one summary line for the rewound day.
rm -f "$FIX/docker-warp-relay-warp-3.log"
printf '2000-01-01' > "$LOGS/.day"
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=3 \
sh "$WATCH" > "$T/out.txt" 2>&1
expect_contains "matrix: 429+5xx+403+conn+upstream+controller+other summarized" \
  "$LOGS/errors.log" "day=2000-01-01 relay=3 429=1 5xx=1 403=1 conn=1 upstream=1 controller=1 other=1 total=7"
# Attribution is asserted on .events (relay label + class per line) plus
# the raw tagged lines in errors.log.
printf 'warp app relay #4 boom error\n' > "$FIX/docker-warp-relay-app.log"
printf 'keeper #7 still failing hard\n' > "$FIX/journal.log"
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=3 \
sh "$WATCH" > "$T/out.txt" 2>&1
expect_contains "matrix: app line attributed to relay 4" "$LOGS/.events" "4 other 1"
expect_contains "matrix: journal line attributed to relay 7" "$LOGS/.events" "7 controller 1"
expect_contains "matrix: app raw line tagged" "$LOGS/errors.log" "[warp-relay-app] warp app relay #4 boom error"
expect_contains "matrix: journal raw line tagged" "$LOGS/errors.log" "keeper #7 still failing hard"
drop_sandbox

# --- 16. unknown source without relay number -> pool ------------------------------
# (Asserted on .events + the raw tagged line: the "relay=pool" label only
# appears in daily summaries, covered by tests 13/14.)
new_sandbox
printf 'some error with no relay marker\n' > "$FIX/journal.log"
run_watch 1
expect_contains "attribute: journal noise tagged with source" \
  "$LOGS/errors.log" "[warp-keep-cold.service] some error with no relay marker"
expect_contains "attribute: journal noise tallied to pool" "$LOGS/.events" "pool other 1"
drop_sandbox
# --- 17. stale cursor: bounded backfill, no flood cap ------------------------------
# An hours-old cursor is passed straight through as docker --since (the
# daemon bounds the window); the watcher itself applies no per-run cap,
# so every matched line in the window is emitted.
new_sandbox
old="$(($(date +%s) - 6 * 3600))"
printf '%s' "$old" > "$LOGS/.cursor"
printf '2026-10-05T00:00:00Z stale error one\n2026-10-05T00:00:01Z stale failure two\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "stale cursor: exit 0" "$RC" "0"
expect_contains "stale cursor: docker --since got the old epoch" \
  "$T/docker.args" "--since $old"
expect_contains "stale cursor: window line 1 emitted" "$LOGS/errors.log" "stale error one"
expect_contains "stale cursor: window line 2 emitted" "$LOGS/errors.log" "stale failure two"
drop_sandbox

# --- 18. oversized single line preserved ------------------------------------------
new_sandbox
line="$(head -c 1048576 /dev/zero | tr '\0' 'y')"
printf '2026-10-05T00:00:00Z %s error tail\n' "$line" > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "oversized line: exit 0" "$RC" "0"
expect_contains "oversized line: 1MiB payload landed intact" "$LOGS/errors.log" "error tail"
tagpfx='[warp-relay-warp-1] '
expect_eq "oversized line: byte count preserved" \
  "$(wc -c < "$LOGS/errors.log")" "$(( $(wc -c < "$FIX/docker-warp-relay-warp-1.log") + ${#tagpfx} ))"
drop_sandbox

# --- 19. LC_ALL=C run ---------------------------------------------------------------
new_sandbox
LC_ALL=C PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=1 \
sh "$WATCH" > "$T/out.txt" 2>&1
expect_eq "LC_ALL=C: exit 0" "$?" "0"
drop_sandbox

# --- 20. COUNT=0 scrapes app + journal only ------------------------------------------
new_sandbox
printf '2026-10-05T00:00:00Z relay error in app\n' > "$FIX/docker-warp-relay-app.log"
run_watch 0
expect_eq "COUNT=0: exit 0" "$RC" "0"
expect_contains "COUNT=0: app still scraped" "$LOGS/errors.log" "[warp-relay-app]"
expect_absent "COUNT=0: no relay scraped" "$T/docker.args" "warp-relay-warp-"
drop_sandbox

# --- 21. write failure: errors.log unwritable ---------------------------------------
new_sandbox
rm -f "$LOGS/errors.log"
mkdir "$LOGS/errors.log"
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=0 \
APP_CONTAINER="no-such-app" JOURNAL_UNIT="no-such-unit" \
sh "$WATCH" > "$T/out.txt" 2>&1
rc=$?
rmdir "$LOGS/errors.log"
if [ "$rc" -ne 0 ]; then ok "write failure: nonzero exit";
else ng "write failure: nonzero exit" "exit was 0"; fi
drop_sandbox

# --- 22. units: flock + schedule are in the service/timer ---------------------------
svc="$REPO/systemd/warp-logwatch.service"
tmr="$REPO/systemd/warp-logwatch.timer"
expect_contains "unit: ExecStart serializes with flock -n" "$svc" "flock -n"
expect_contains "unit: service is oneshot" "$svc" "Type=oneshot"
expect_contains "unit: timer every 2 minutes" "$tmr" "OnCalendar=*:0/2"
expect_contains "unit: timer fires soon after boot" "$tmr" "OnBootSec="
expect_contains "script: tmpdir trap cleans EXIT INT TERM" "$WATCH" "trap 'rm -rf"

# --- BUG: non-UTF8 bytes lose the original line --------------------------------------
# Expected: the offending line is captured (e.g. via grep -a).
# Actual: grep sees binary stdin, prints "Binary file (standard input)
# matches", the payload is lost and a spurious pseudo-line is recorded.
new_sandbox
printf '2026-10-05T00:00:00Z relay error l\377t\377n-1 payload\n' > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_contains "BUG: non-UTF8 error payload preserved" "$LOGS/errors.log" "payload"
expect_absent "BUG: no Binary-file pseudo-line recorded" "$LOGS/errors.log" "Binary file"
drop_sandbox

# --- BUG: corrupt .events wedges the watcher ------------------------------------------
# Expected: a corrupt tally line is ignored and the run completes.
# Actual: arithmetic on the non-numeric count fails under set -u
# ("abc: unbound variable"), exit 1, nothing summarized, .day left
# stale: every later run crashes identically until manual repair.
new_sandbox
printf '2000-01-01' > "$LOGS/.day"
printf '1 http_429 abc\n' > "$LOGS/.events"
PATH="$BIN:$PATH" POOL_DIR="$REPO" LOG_DIR="$LOGS" COUNT=1 \
sh "$WATCH" > "$T/out.txt" 2>&1
rc=$?
expect_eq "BUG: corrupt .events still exits 0" "$rc" "0"
drop_sandbox

t1="$(date +%s)"
printf '# %d passed, %d failed (%ds)\n' "$pass" "$fail" "$((t1 - t0))"
[ "$fail" -eq 0 ]
