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
# WATCH=/path/to/logwatch.sh runs the suite against another copy (used
# to prove the refetch regression tests fail on the pre-fix script).
WATCH="${WATCH:-$REPO/logwatch.sh}"

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
cursor_state="$(cat "$LOGS/.cursor" 2>/dev/null || true)"
case "$cursor_state" in
  ''|*[!0-9]*) cursor_ok=no ;;
  *) cursor_ok=yes ;;
esac
expect_eq "overlap: cursor holds an epoch timestamp" "$cursor_ok" "yes"
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

# --- 23. refetch overlap: two distinct lines must fold --------------------
# .cursor is the run START, so the next --since re-delivers every line
# from [run-start, scrape-time]. The old single-line .last skip folded
# only one boundary line: with a 2-line refetch (A,B then A,B,C) it
# re-emitted and re-tallied A and B. Regression guard for the exact
# A,B -> A,B,C repro.
new_sandbox
printf '2026-10-05T00:00:00Z A error one\n2026-10-05T00:00:01Z B failure two\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "overlap2: run1 emits both lines" "$(wc -l < "$LOGS/errors.log")" "2"
printf '2026-10-05T00:00:00Z A error one\n2026-10-05T00:00:01Z B failure two\n2026-10-05T00:00:02Z C timeout three\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "overlap2: run2 appends ONLY the new line" \
  "$(wc -l < "$LOGS/errors.log")" "3"
expect_contains "overlap2: new line present" "$LOGS/errors.log" "C timeout three"
expect_eq "overlap2: A not re-emitted" \
  "$(grep -cF 'A error one' "$LOGS/errors.log")" "1"
expect_eq "overlap2: B not re-emitted" \
  "$(grep -cF 'B failure two' "$LOGS/errors.log")" "1"
expect_eq "overlap2: tallies not inflated" \
  "$(awk '{s+=$3} END{print s+0}' "$LOGS/.events")" "3"
drop_sandbox

# --- 24. refetch overlap on the journal source ----------------------------
# Same fold through the "MMM DD HH:MM:SS" key path.
new_sandbox
j1='Oct 05 00:00:00 host warp-keep-cold[1]: troubled: still failing one'
j2='Oct 05 00:00:01 host warp-keep-cold[1]: troubled: still failing two'
j3='Oct 05 00:00:02 host warp-keep-cold[1]: troubled: still failing three'
printf '%s\n%s\n' "$j1" "$j2" > "$FIX/journal.log"
run_watch 1
expect_eq "journal overlap: run1 emits both lines" "$(wc -l < "$LOGS/errors.log")" "2"
printf '%s\n%s\n%s\n' "$j1" "$j2" "$j3" > "$FIX/journal.log"
run_watch 1
expect_eq "journal overlap: run2 appends ONLY the new line" \
  "$(wc -l < "$LOGS/errors.log")" "3"
expect_eq "journal overlap: first line not re-emitted" \
  "$(grep -cF 'troubled: still failing one' "$LOGS/errors.log")" "1"
expect_eq "journal overlap: tallies not inflated" \
  "$(awk '{s+=$3} END{print s+0}' "$LOGS/.events")" "3"
drop_sandbox

# --- 25. repeat chain: identical refetches must not re-emit ---------------
# Two extra runs over an unchanged refetch, then one new line: exactly
# one more emission, ever.
new_sandbox
printf '2026-10-05T00:00:00Z A error one\n2026-10-05T00:00:01Z B failure two\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
run_watch 1
expect_eq "chain: unchanged refetch adds nothing" "$(wc -l < "$LOGS/errors.log")" "2"
printf '2026-10-05T00:00:00Z A error one\n2026-10-05T00:00:01Z B failure two\n2026-10-05T00:00:02Z C timeout three\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "chain: new line added exactly once" "$(wc -l < "$LOGS/errors.log")" "3"
expect_eq "chain: tally total unchanged at 3" \
  "$(awk '{s+=$3} END{print s+0}' "$LOGS/.events")" "3"
drop_sandbox

# --- 26. same-second burst: identical lines, one timestamp ----------------
# Three byte-identical lines share one exact timestamp; a 4th identical
# line arrives before the next run. Text identity cannot tell how many
# were already counted — only the stored per-key occurrence count can.
new_sandbox
burst='2026-10-05T00:00:00Z 429 too many requests'
printf '%s\n%s\n%s\n' "$burst" "$burst" "$burst" > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_contains "burst: run1 collapses the trio" "$LOGS/errors.log" \
  "429 too many requests (x3)"
printf '%s\n%s\n%s\n%s\n' "$burst" "$burst" "$burst" "$burst" > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "burst: run2 adds exactly the 4th occurrence" \
  "$(wc -l < "$LOGS/errors.log")" "2"
expect_absent "burst: no re-collapsed (x6) line" "$LOGS/errors.log" "(x6)"
expect_eq "burst: tally total is exactly 4" \
  "$(awk '{s+=$3} END{print s+0}' "$LOGS/.events")" "4"
drop_sandbox

# --- 27. journal same-second burst ----------------------------------------
# Journal stamps whole seconds, so same-key bursts are the norm there.
new_sandbox
jburst='Oct 05 12:00:00 host warp-keep-cold[1]: 429 too many requests'
printf '%s\n%s\n' "$jburst" "$jburst" > "$FIX/journal.log"
run_watch 1
expect_contains "journal burst: run1 collapses the pair" "$LOGS/errors.log" "(x2)"
printf '%s\n%s\n%s\n' "$jburst" "$jburst" "$jburst" > "$FIX/journal.log"
run_watch 1
expect_eq "journal burst: run2 adds exactly one occurrence" \
  "$(wc -l < "$LOGS/errors.log")" "2"
expect_eq "journal burst: tally total is exactly 3" \
  "$(awk '{s+=$3} END{print s+0}' "$LOGS/.events")" "3"
drop_sandbox

# --- 28. flock contention is a successful no-op ---------------------------
# -E 0 makes timer overlap exit 0 so a skipped run never marks the unit
# failed; the flock -n serialization itself must stay.
expect_contains "unit: flock still serializes (-n)" "$svc" "flock -n"
expect_contains "unit: flock contention exits 0 (-E 0)" "$svc" "-E 0"

# --- 29. junk heads: CLI stderr keys BELOW every real line ----------------
# A container gone mid-scrape leaves only docker's stderr line ("Error:
# No such container ..."), which has no timestamp. It must key below
# every real line: a content-derived key like "Error:.000000000" sorts
# ABOVE "2026-..." heads, so the next fetch's real lines would be
# classified old, folded into the re-armed boundary and lost forever
# (never logged, never tallied). Repro: run1 [junk] then run2
# [ts A, ts B] must emit BOTH real lines.
new_sandbox
printf 'Error: No such container: warp-relay-warp-1\n' > "$FIX/docker-fail-warp-relay-warp-1"
run_watch 1
expect_eq "junk: run1 records the CLI error" \
  "$(grep -cF 'No such container' "$LOGS/errors.log")" "1"
expect_eq "junk: run1 boundary stores the junk sentinel" \
  "$(cat "$LOGS/.last")" "$(printf 'warp-relay-warp-1\t0000-00-00T00:00:00.000000000\t1')"
n_ev1="$(awk '{s+=$3} END{print s+0}' "$LOGS/.events")"
rm -f "$FIX/docker-fail-warp-relay-warp-1"
printf '2026-10-05T00:00:00Z A error one\n2026-10-05T00:00:01Z B failure two\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "junk: run2 emits both real lines after a junk boundary" \
  "$(wc -l < "$LOGS/errors.log")" "3"
expect_contains "junk: line A emitted" "$LOGS/errors.log" "A error one"
expect_contains "junk: line B emitted" "$LOGS/errors.log" "B failure two"
expect_eq "junk: run2 tallies exactly the 2 new lines" \
  "$(( $(awk '{s+=$3} END{print s+0}' "$LOGS/.events") - n_ev1 ))" "2"
drop_sandbox

# --- 30. junk heads: a real boundary must not suppress a fresh CLI error --
# Reverse order: run1 healthy (ts A stored as boundary), then the
# container disappears. The stderr line keys below the real boundary, so
# the "<" branch alone would swallow it as old — but its head carries no
# time, so positional proof of "already seen" does not exist for it.
# While the outage persists the identical line folds via the ==/count
# path (one emission per outage); recovery emits the new real line.
new_sandbox
printf '2026-10-05T00:00:00Z A error one\n' > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "junkflap: run1 emits the healthy line" \
  "$(wc -l < "$LOGS/errors.log")" "1"
printf 'Error: No such container: warp-relay-warp-1\n' > "$FIX/docker-fail-warp-relay-warp-1"
run_watch 1
expect_eq "junkflap: run2 records the CLI error despite the real boundary" \
  "$(grep -cF 'No such container' "$LOGS/errors.log")" "1"
expect_eq "junkflap: run2 boundary became the junk sentinel" \
  "$(cat "$LOGS/.last")" "$(printf 'warp-relay-warp-1\t0000-00-00T00:00:00.000000000\t1')"
run_watch 1
expect_eq "junkflap: run3 folds the same outage (no re-record)" \
  "$(grep -cF 'No such container' "$LOGS/errors.log")" "1"
rm -f "$FIX/docker-fail-warp-relay-warp-1"
printf '2026-10-05T00:00:01Z B failure two\n' > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "junkflap: run4 emits the recovered real line" \
  "$(grep -cF 'B failure two' "$LOGS/errors.log")" "1"
drop_sandbox

# --- 31. corrupt stored boundary key: shape-rejected ----------------------
# .last is state; a key outside the known shapes (hand-edited, corrupt,
# or the pre-fix content-derived junk key surviving an in-place upgrade)
# must be treated as absent: re-emitting duplicates is safe, silently
# swallowing real lines is not. 99999999999999 is the verified swallow
# vector — it outranks every real key under plain string order.
new_sandbox
printf 'warp-relay-warp-1\t99999999999999\t2\n' > "$LOGS/.last"
printf '2026-10-05T00:00:00Z A error one\n2026-10-05T00:00:01Z B failure two\n' \
  > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "corrupt: 99999999999999 does not swallow docker lines" \
  "$(wc -l < "$LOGS/errors.log")" "2"
expect_contains "corrupt: line A emitted" "$LOGS/errors.log" "A error one"
expect_contains "corrupt: line B emitted" "$LOGS/errors.log" "B failure two"
# legacy shape: the pre-fix code keyed junk heads by content
# ("Error:.000000000"), which a deployed host can still have on disk.
printf 'warp-relay-warp-1\tError:.000000000\t1\n' > "$LOGS/.last"
printf '2026-10-05T00:00:02Z C timeout three\n' > "$FIX/docker-warp-relay-warp-1.log"
run_watch 1
expect_eq "corrupt: legacy content-derived junk key rejected too" \
  "$(grep -cF 'C timeout three' "$LOGS/errors.log")" "1"
# same rejection through the journal source (14-digit keys).
rm -f "$FIX/docker-warp-relay-warp-1.log"
printf 'warp-keep-cold.service\t99999999999999\t2\n' > "$LOGS/.last"
printf 'Oct 05 00:00:00 host warp-keep-cold[1]: troubled: still failing one\n' > "$FIX/journal.log"
run_watch 1
expect_eq "corrupt: journal source rejects the swallow key too" \
  "$(grep -cF 'still failing one' "$LOGS/errors.log")" "1"
drop_sandbox

# --- 32. journal junk heads: same sentinel contract ------------------------
# Journal lines without the journald "MMM DD HH:MM:SS" head (a bare
# controller line a wrapper captured, etc.) key as the all-zero 14-digit
# sentinel: below every real key, never suppressed by a real boundary,
# folding only on an exact repeat while one outage persists.
new_sandbox
printf 'keeper #7 still failing hard\n' > "$FIX/journal.log"
run_watch 1
expect_eq "jjunk: run1 records the junk-headed line" \
  "$(grep -cF 'keeper #7 still failing hard' "$LOGS/errors.log")" "1"
expect_eq "jjunk: run1 boundary is the journal sentinel" \
  "$(cat "$LOGS/.last")" "$(printf 'warp-keep-cold.service\t00000000000000\t1')"
j1='Oct 05 00:00:00 host warp-keep-cold[1]: troubled: still failing one'
j2='Oct 05 00:00:01 host warp-keep-cold[1]: troubled: still failing two'
printf '%s\n%s\n' "$j1" "$j2" > "$FIX/journal.log"
run_watch 1
expect_eq "jjunk: recovery after junk boundary emits both real lines" \
  "$(wc -l < "$LOGS/errors.log")" "3"
printf 'keeper #7 still failing hard\n' > "$FIX/journal.log"
run_watch 1
expect_eq "jjunk: second outage emits despite the real boundary" \
  "$(grep -cF 'keeper #7 still failing hard' "$LOGS/errors.log")" "2"
run_watch 1
expect_eq "jjunk: same outage folds (no re-record)" \
  "$(grep -cF 'keeper #7 still failing hard' "$LOGS/errors.log")" "2"
printf 'Oct 05 00:00:02 host warp-keep-cold[1]: troubled: still failing three\n' > "$FIX/journal.log"
run_watch 1
expect_eq "jjunk: recovery after junk boundary emits" \
  "$(grep -cF 'troubled: still failing three' "$LOGS/errors.log")" "1"
drop_sandbox

t1="$(date +%s)"
printf '# %d passed, %d failed (%ds)\n' "$pass" "$fail" "$((t1 - t0))"
[ "$fail" -eq 0 ]
