#!/bin/sh
# logwatch.sh — central error-log watcher for the warp-relay pool.
#
# Scrapes `docker logs --since` for the relay app + warp-1..N and
# `journalctl --since` for the keep-cold controller, appends matching
# error lines to logs/errors.log, and emits one summary line per relay
# per day. Read-only on the pool: never restarts or rebuilds anything.
#
# Usage: ./logwatch.sh            (every 2 min via warp-logwatch.timer)
#   POOL_DIR=...      pool checkout (default: directory of this script)
#   LOG_DIR=...       output dir (default: $POOL_DIR/logs)
#   COUNT=...         relay count (default 10)
#   CONTAINER_PREFIX=...  (default warp-relay-warp-)
#   APP_CONTAINER=...     (default warp-relay-app)
#   JOURNAL_UNIT=...      (default warp-keep-cold.service)
#   MAX_BYTES=...     rotate errors.log at this size (default 10485760)
#   KEEP_ROTATED=...  rotated files to keep (default 5)
#   FIRST_SINCE_DOCKER=...  (default 24h; used only with no cursor yet)
#   FIRST_SINCE_JOURNAL=... (default "24 hours ago"; same)
#
# State (all inside $LOG_DIR, survives restarts):
#   .cursor  epoch seconds of the last scrape start (next --since)
#   .last    per source "src<TAB>key<TAB>count": normalized timestamp key
#            of the last fetched line, or the head's junk sentinel when it
#            carries no timestamp + how many fetched lines shared it
#            (the exact --since refetch-overlap skip; see process_source)
#   .events  "relay class n" tallies for the current UTC day
#   .day     UTC day (YYYY-MM-DD) the .events tallies belong to
set -eu

POOL_DIR="${POOL_DIR:-$(cd "$(dirname "$0")" && pwd)}"
LOG_DIR="${LOG_DIR:-$POOL_DIR/logs}"
COUNT="${COUNT:-10}"
CONTAINER_PREFIX="${CONTAINER_PREFIX:-warp-relay-warp-}"
APP_CONTAINER="${APP_CONTAINER:-warp-relay-app}"
TUNNEL_PREFIX="${TUNNEL_PREFIX:-warp-relay-tunnel-}"
JOURNAL_UNIT="${JOURNAL_UNIT:-warp-keep-cold.service}"
MAX_BYTES="${MAX_BYTES:-10485760}"
KEEP_ROTATED="${KEEP_ROTATED:-5}"
FIRST_SINCE_DOCKER="${FIRST_SINCE_DOCKER:-24h}"
FIRST_SINCE_JOURNAL="${FIRST_SINCE_JOURNAL:-24 hours ago}"

ERRLOG="$LOG_DIR/errors.log"
CURSOR="$LOG_DIR/.cursor"
LAST="$LOG_DIR/.last"
EVENTS="$LOG_DIR/.events"
DAYFILE="$LOG_DIR/.day"

# Case-insensitive (callers pass -i). Bare 429/500/502/403 are
# digit-guarded so PIDs and ports never match; everything else is a
# plain substring. g(a|i)ve covers both GIVE UP and GAVE UP.
MATCH_RE='error|fail|refus|timeout|g(a|i)ve up|troubled|server_error|still failing|unexpected http|proxy error|fetch failed|econnrefused|epipe|(^|[^0-9])(429|500|502|403)([^0-9]|$)'

# Compare two source keys in C collation. `test` has no portable `<`, and the
# keys mix fixed-width timestamps with junk sentinels; the x-prefix forces
# expr's string mode. Used only inside a refetch-overlap window.
key_lt() {
  [ "$(LC_ALL=C expr "x$1" \< "x$2" 2>/dev/null)" = "1" ]
}

# Junk-key sentinels: normalized keys for heads that carry no usable
# timestamp — docker CLI stderr ("Error: No such container: ...") and
# journal lines without a journald "MMM DD HH:MM:SS" prefix. Each sorts
# BELOW every real key of its mode ("0" < "2" in docker; an all-zero
# 14-digit key is the flat minimum for journal), so a stored junk
# boundary can never swallow real lines. process_source holds the
# mirror rule for the other direction (see the skip predicate there).
JUNK_DOCKER='0000-00-00T00:00:00.000000000'
JUNK_JOURNAL='00000000000000'

mkdir -p "$LOG_DIR"
TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_WORK"' EXIT INT TERM

NOW="$(date +%s)"
TODAY="$(date -u +%F)"
STAMP="$(date -u +%FT%TZ)"
RUN_YEAR="$(date -u +%Y)"
RUN_MON="$(date -u +%m)"

if [ -f "$CURSOR" ]; then
  SINCE_EPOCH="$(cat "$CURSOR")"
  case "$SINCE_EPOCH" in ''|*[!0-9]*) SINCE_EPOCH="";; esac
else
  SINCE_EPOCH=""
fi

rotate() {
  # Rotate errors.log at MAX_BYTES, keeping KEEP_ROTATED files:
  # errors.log.1 .. errors.log.KEEP_ROTATED (60 MiB cap at defaults).
  [ -f "$ERRLOG" ] || return 0
  rot_size="$(wc -c < "$ERRLOG")"
  [ "$rot_size" -ge "$MAX_BYTES" ] || return 0
  rot_i="$KEEP_ROTATED"
  while [ "$rot_i" -gt 1 ]; do
    rot_prev=$((rot_i - 1))
    [ -f "$ERRLOG.$rot_prev" ] && mv -f "$ERRLOG.$rot_prev" "$ERRLOG.$rot_i"
    rot_i="$rot_prev"
  done
  mv -f "$ERRLOG" "$ERRLOG.1"
}

classify() {
  # Echo the error class for one matched line ($1).
  line="$1"
  if printf '%s' "$line" | grep -qi -E '(^|[^0-9])429([^0-9]|$)'; then echo http_429
  elif printf '%s' "$line" | grep -qi -E '(^|[^0-9])(500|502)([^0-9]|$)|unexpected http'; then echo http_5xx
  elif printf '%s' "$line" | grep -qi -E '(^|[^0-9])403([^0-9]|$)'; then echo http_403
  elif printf '%s' "$line" | grep -qi -E 'refus|timeout|econnrefused|epipe|fetch failed|proxy error'; then echo conn
  elif printf '%s' "$line" | grep -qi -E 'server_error'; then echo upstream
  elif printf '%s' "$line" | grep -qi -E 'g(a|i)ve up|troubled|still failing'; then echo controller
  else echo other
  fi
}

attribute() {
  # Echo the relay label (1..N, app, pool) for source $1 + line $2.
  src="$1"
  line="$2"
  case "$src" in
    "$CONTAINER_PREFIX"*)
      echo "${src#$CONTAINER_PREFIX}"
      return 0
      ;;
    "$APP_CONTAINER")
      n="$(printf '%s' "$line" | sed -n 's/.*[Rr]elay[^0-9]*#\?\([0-9][0-9]*\).*/\1/p' | head -n 1)"
      [ -n "$n" ] && echo "$n" || echo "app"
      return 0
      ;;
  esac
  n="$(printf '%s' "$line" | sed -n 's/.*#\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  [ -n "$n" ] && echo "$n" || echo "pool"
}

get_boundary() {
  # Echo "<key> <count>" for source $1 (empty when absent/corrupt).
  # key = normalized timestamp key of the last fetched line, count =
  # how many fetched lines shared that key (the trailing run length).
  #
  # The stored key must also match a KNOWN key shape: one of the two
  # junk sentinels or a year-bounded real key of either mode. Anything
  # else is corrupt state (hand-edited, truncated, or the pre-fix
  # content-derived docker key surviving an in-place upgrade) and is
  # treated as absent — the skip then re-emits instead of swallowing;
  # the old journal pseudo-key 20YY0000000000 stays shape-valid and is
  # provably harmless (it sorts below that year's real keys, and junk
  # keys are exempt from the '<' branch anyway).
  # when loss and duplication conflict, duplication is the safe side.
  # (Repeated [0-9] classes, not {9}/{10} intervals: pre-2020 mawk and
  # traditional awk lack ERE intervals.)
  [ -f "$LAST" ] || return 0
  awk -F'\t' -v s="$1" -v jd="$JUNK_DOCKER" -v jj="$JUNK_JOURNAL" '
    $1 == s && $3 ~ /^[0-9]+$/ &&
    ($2 == jd || $2 == jj ||
     $2 ~ /^(20|21)[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]$/ ||
     $2 ~ /^(20|21)[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]$/) {
      printf "%s %d\n", $2, $3 + 0
      exit
    }' "$LAST"
  return 0
}

set_boundary() {
  # Overwrite source $1's boundary record: key $2 + trailing-run count $3.
  sb_tmp="$TMPDIR_WORK/last.new"
  if [ -f "$LAST" ]; then
    awk -F'\t' -v s="$1" '$1 != s' "$LAST" > "$sb_tmp"
  else
    : > "$sb_tmp"
  fi
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$sb_tmp"
  mv -f "$sb_tmp" "$LAST"
}

emit_group() {
  # Append one (possibly collapsed) group: source $1, raw line $2,
  # repeat count $3. Records the daily tally with its multiplicity.
  # NOTE: locals are eg_-prefixed — sh functions share global scope,
  # and callers (process_source) rely on their own vars surviving.
  eg_src="$1"; eg_line="$2"; eg_count="$3"
  if [ "$eg_count" -gt 1 ]; then
    printf '[%s] %s (x%d)\n' "$eg_src" "$eg_line" "$eg_count" >> "$ERRLOG"
  else
    printf '[%s] %s\n' "$eg_src" "$eg_line" >> "$ERRLOG"
  fi
  eg_class="$(classify "$eg_line")"
  eg_relay="$(attribute "$eg_src" "$eg_line")"
  printf '%s %s %d\n' "$eg_relay" "$eg_class" "$eg_count" >> "$EVENTS"
}

process_source() {
  # $1 source, $2 fetched-lines file, $3 timestamp mode (docker|journal).
  # Skips the --since refetch overlap exactly, collapses consecutive
  # repeats, emits groups, then re-arms the source's boundary.
  #
  # Why this is exact and gap-free: .cursor is the run's START second C,
  # so this run's --since C re-fetches every line written after the
  # previous run's scrape of this source (log timestamps are host-clock
  # non-decreasing, so every line written at/after C has ts >= C — the
  # gap-free invariant). Re-fetched lines are exactly the already-seen
  # ones iff their key < P, or their key == P within the first C
  # occurrences of P — where P/C are the previous run's last-line key
  # and its trailing-run count: every refetched line with key < P
  # existed before the previous scrape and was fetched by it, and lines
  # with key == P come back in insertion order, so the first C are
  # precisely the C occurrences the previous run saw. Identical repeated
  # lines (today's norm) are therefore counted positionally, never
  # matched by text. The boundary is re-armed from the WHOLE fetched
  # stream (skipped lines included) so the skip chains correctly across
  # any number of runs. NOTE: ps_-prefixed vars — emit_group shares
  # global scope and must not clobber these.
  #
  # Timestamp-less heads (docker CLI stderr, journal lines without the
  # journald prefix) normalize to the mode's junk sentinel, which sorts
  # below every real key. Two consequences: a stored junk boundary can
  # never swallow real lines, and the skip predicate below never calls
  # junk "old" via the < branch when a real boundary is stored — only
  # the ==/count path folds junk, i.e. one emission per outage (CLI
  # stderr reappears on every run while a container is missing, so it
  # must be foldable, yet a first occurrence must survive a healthy
  # run's boundary).
  ps_src="$1"; ps_file="$2"; ps_mode="$3"
  [ -s "$ps_file" ] || return 0
  ps_b="$(get_boundary "$ps_src")"
  ps_pkey="${ps_b%% *}"
  ps_pcnt="${ps_b#* }"
  if [ -z "$ps_b" ]; then ps_pcnt=0; fi
  ps_oldn=0
  ps_bkey=""; ps_bcnt=0
  ps_cur=""; ps_count=0
  while IFS= read -r ps_line || [ -n "$ps_line" ]; do
    [ -n "$ps_line" ] || continue
    case "$ps_mode" in
      docker)
        # RFC3339(Nano) first field -> YYYY-MM-DDTHH:MM:SS.fffffffff
        # (fraction zero-padded to 9 digits so plain string order is
        # time order). Anything unparseable folds to the junk sentinel
        # (stable, and below every real key — see the case below).
        ps_ts="${ps_line%% *}"
        ps_ts="${ps_ts%Z}"
        case "$ps_ts" in
          *.*) ps_core="${ps_ts%%.*}"; ps_frac="${ps_ts#*.}";;
          *) ps_core="$ps_ts"; ps_frac="";;
        esac
        case "$ps_frac" in *[!0-9]*) ps_frac="";; esac
        while [ "${#ps_frac}" -lt 9 ]; do ps_frac="${ps_frac}0"; done
        while [ "${#ps_frac}" -gt 9 ]; do ps_frac="${ps_frac%?}"; done
        # Heads that are not the RFC3339 shape (docker CLI stderr) fold
        # to the junk sentinel instead of leaking content into the key:
        # a content-derived key like "Error:.000000000" sorts ABOVE real
        # timestamps and the skip predicate would silently mark real
        # lines old (lost forever). The sentinel sorts below them.
        case "$ps_core" in
          [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9])
            ps_lk="$ps_core.$ps_frac";;
          *) ps_lk="$JUNK_DOCKER";;
        esac
        ;;
      journal)
        # "MMM DD HH:MM:SS" -> YYYYMMDDHHMMSS. Month name maps to digits
        # and the year is inferred from now, nudged +/-1 across a New
        # Year boundary (a Dec entry in a January run is last year's,
        # and vice versa). Heads that do not parse fold to the junk
        # sentinel: a year-prefixed pseudo-key ("20260000000000") would
        # outrank and swallow December's real keys in a January run
        # (and November/December's in the mirror case).
        ps_mon="${ps_line%"${ps_line#???}"}"
        ps_rest="${ps_line#??? }"
        ps_rest="${ps_rest#"${ps_rest%%[! ]*}"}"
        ps_day="${ps_rest%% *}"
        ps_hms="${ps_rest#* }"; ps_hms="${ps_hms%% *}"
        case "$ps_mon" in
          Jan) ps_mn=01;; Feb) ps_mn=02;; Mar) ps_mn=03;; Apr) ps_mn=04;;
          May) ps_mn=05;; Jun) ps_mn=06;; Jul) ps_mn=07;; Aug) ps_mn=08;;
          Sep) ps_mn=09;; Oct) ps_mn=10;; Nov) ps_mn=11;; Dec) ps_mn=12;;
          *) ps_mn="";;
        esac
        case "$ps_day" in
          ''|*[!0-9]*) ps_day="";;
          *)
            # string-only zero handling: $((08)) is invalid POSIX octal.
            ps_day="${ps_day#0}"
            case "$ps_day" in
              '') ps_day=00;;
              ?) ps_day="0$ps_day";;
            esac
            ;;
        esac
        case "$ps_hms" in
          [0-9][0-9]:[0-9][0-9]:[0-9][0-9])
            ps_h="${ps_hms%%:*}"; ps_hm="${ps_hms#*:}"
            ps_m="${ps_hm%%:*}"; ps_s="${ps_hm#*:}"
            ps_hms="$ps_h$ps_m$ps_s";;
          *) ps_hms="";;
        esac
        if [ -z "$ps_mn" ] || [ -z "$ps_day" ] || [ -z "$ps_hms" ]; then
          ps_lk="$JUNK_JOURNAL"
        else
          ps_year="$RUN_YEAR"
          case "$RUN_MON$ps_mn" in
            0112) ps_year=$((ps_year - 1));;
            1201) ps_year=$((ps_year + 1));;
          esac
          ps_lk="$ps_year$ps_mn$ps_day$ps_hms"
        fi
        ;;
      *)
        ps_lk="${ps_line%% *}"
        ;;
    esac
    # Boundary watermark over the whole stream, skipped lines included.
    if [ "$ps_lk" = "$ps_bkey" ]; then
      ps_bcnt=$((ps_bcnt + 1))
    else
      ps_bkey="$ps_lk"; ps_bcnt=1
    fi
    # Refetch-overlap skip (see the comment above this function).
    if [ -n "$ps_b" ]; then
      ps_old=no
      if key_lt "$ps_lk" "$ps_pkey"; then
        ps_old=yes
        # A junk key sorts below every real key by construction, so the
        # < branch alone would silently drop a first-occurrence
        # timestamp-less line (docker CLI stderr) whenever a healthy
        # run's real boundary is stored — exactly the disappearance the
        # log must record. Junk heads carry no time, so no positional
        # "already seen" proof exists for them: only the ==/count path
        # below may fold junk (repeats within one outage); a first
        # occurrence is always new. ERE alternation is unavailable in
        # case patterns, hence the mode switch.
        case "$ps_mode" in
          docker) [ "$ps_lk" = "$JUNK_DOCKER" ] && ps_old=no;;
          journal) [ "$ps_lk" = "$JUNK_JOURNAL" ] && ps_old=no;;
        esac
      elif [ "$ps_lk" = "$ps_pkey" ] && [ "$ps_oldn" -lt "$ps_pcnt" ]; then
        ps_oldn=$((ps_oldn + 1))
        ps_old=yes
      fi
      if [ "$ps_old" = yes ]; then continue; fi
    fi
    if [ "$ps_count" -eq 0 ]; then
      ps_cur="$ps_line"; ps_count=1
    elif [ "$ps_line" = "$ps_cur" ]; then
      ps_count=$((ps_count + 1))
    else
      emit_group "$ps_src" "$ps_cur" "$ps_count"
      ps_cur="$ps_line"; ps_count=1
    fi
  done < "$ps_file"
  if [ "$ps_count" -gt 0 ]; then
    emit_group "$ps_src" "$ps_cur" "$ps_count"
  fi
  if [ "$ps_bcnt" -gt 0 ]; then
    set_boundary "$ps_src" "$ps_bkey" "$ps_bcnt"
  fi
}

summarize_day() {
  # Append one summary line per relay for day $1, aggregated from
  # .events, then clear the tallies. Relays 1..N always get a line
  # (zeros prove the watcher ran); app/pool only when nonzero.
  # NOTE: sum_-prefixed vars — the main scrape loop below uses $i.
  sum_day="$1"
  sum_i=1
  while [ "$sum_i" -le "$COUNT" ]; do
    sum_tally="$TMPDIR_WORK/tally.$sum_i"
    : > "$sum_tally"
    [ -f "$EVENTS" ] && grep "^$sum_i " "$EVENTS" > "$sum_tally" || true
    sum_429=0; sum_5xx=0; sum_403=0; sum_conn=0; sum_up=0; sum_ctrl=0; sum_other=0
    while read -r sum_r sum_cls sum_n || [ -n "$sum_r" ]; do
      [ -z "${sum_r:-}" ] && continue
      case "${sum_n:-}" in ''|*[!0-9]*) continue;; esac
      case "$sum_cls" in
        http_429) sum_429=$((sum_429 + sum_n));;
        http_5xx) sum_5xx=$((sum_5xx + sum_n));;
        http_403) sum_403=$((sum_403 + sum_n));;
        conn) sum_conn=$((sum_conn + sum_n));;
        upstream) sum_up=$((sum_up + sum_n));;
        controller) sum_ctrl=$((sum_ctrl + sum_n));;
        *) sum_other=$((sum_other + sum_n));;
      esac
    done < "$sum_tally"
    sum_total=$((sum_429 + sum_5xx + sum_403 + sum_conn + sum_up + sum_ctrl + sum_other))
    printf '%s [summary] day=%s relay=%d 429=%d 5xx=%d 403=%d conn=%d upstream=%d controller=%d other=%d total=%d\n' \
      "$STAMP" "$sum_day" "$sum_i" "$sum_429" "$sum_5xx" "$sum_403" "$sum_conn" "$sum_up" "$sum_ctrl" "$sum_other" "$sum_total" >> "$ERRLOG"
    sum_i=$((sum_i + 1))
  done
  for sum_label in app pool; do
    sum_tally="$TMPDIR_WORK/tally.$sum_label"
    : > "$sum_tally"
    [ -f "$EVENTS" ] && grep "^$sum_label " "$EVENTS" > "$sum_tally" || true
    [ -s "$sum_tally" ] || continue
    sum_429=0; sum_5xx=0; sum_403=0; sum_conn=0; sum_up=0; sum_ctrl=0; sum_other=0
    while read -r sum_r sum_cls sum_n || [ -n "$sum_r" ]; do
      [ -z "${sum_r:-}" ] && continue
      case "${sum_n:-}" in ''|*[!0-9]*) continue;; esac
      case "$sum_cls" in
        http_429) sum_429=$((sum_429 + sum_n));;
        http_5xx) sum_5xx=$((sum_5xx + sum_n));;
        http_403) sum_403=$((sum_403 + sum_n));;
        conn) sum_conn=$((sum_conn + sum_n));;
        upstream) sum_up=$((sum_up + sum_n));;
        controller) sum_ctrl=$((sum_ctrl + sum_n));;
        *) sum_other=$((sum_other + sum_n));;
      esac
    done < "$sum_tally"
    sum_total=$((sum_429 + sum_5xx + sum_403 + sum_conn + sum_up + sum_ctrl + sum_other))
    printf '%s [summary] day=%s relay=%s 429=%d 5xx=%d 403=%d conn=%d upstream=%d controller=%d other=%d total=%d\n' \
      "$STAMP" "$sum_day" "$sum_label" "$sum_429" "$sum_5xx" "$sum_403" "$sum_conn" "$sum_up" "$sum_ctrl" "$sum_other" "$sum_total" >> "$ERRLOG"
  done
  : > "$EVENTS"
}

# Day rollover: yesterday's tallies become summary lines first.
if [ -f "$DAYFILE" ]; then
  prev_day="$(cat "$DAYFILE")"
else
  prev_day="$TODAY"
  printf '%s' "$TODAY" > "$DAYFILE"
fi
rotate
: >> "$ERRLOG"
if [ "$prev_day" != "$TODAY" ]; then
  summarize_day "$prev_day"
  printf '%s' "$TODAY" > "$DAYFILE"
fi
[ -f "$EVENTS" ] || : > "$EVENTS"

# Scrape docker sources with timestamps (timestamps ride along as the
# log timestamp, so no clock conversion is needed anywhere).
if [ -n "$SINCE_EPOCH" ]; then
  D_SINCE="$SINCE_EPOCH"
  J_SINCE="@$SINCE_EPOCH"
else
  D_SINCE="$FIRST_SINCE_DOCKER"
  J_SINCE="$FIRST_SINCE_JOURNAL"
fi

scrape_docker() {
  # Matched raw lines for container $1 go to stdout (never fails).
  docker logs --timestamps --since "$D_SINCE" "$1" 2>&1 \
    | grep -a -i -E "$MATCH_RE" || true
}

i=1
while [ "$i" -le "$COUNT" ]; do
  out="$TMPDIR_WORK/docker-$i"
  scrape_docker "$CONTAINER_PREFIX$i" > "$out" || true
  process_source "$CONTAINER_PREFIX$i" "$out" docker
  i=$((i + 1))
done

out="$TMPDIR_WORK/docker-app"
scrape_docker "$APP_CONTAINER" > "$out" || true
process_source "$APP_CONTAINER" "$out" docker

# Tunnels are optional (mesh installs have none) and their death silently
# breaks every configured client URL, so watch the ones that exist. One
# `docker ps` beats COUNT inspect calls on every scrape.
RUNNING_CONTAINERS="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
for name in $RUNNING_CONTAINERS; do
  case "$name" in
    "${TUNNEL_PREFIX}"[0-9]*) ;;
    *) continue ;;
  esac
  out="$TMPDIR_WORK/$name"
  scrape_docker "$name" > "$out" || true
  process_source "$name" "$out" docker
done

out="$TMPDIR_WORK/journal"
  journalctl -u "$JOURNAL_UNIT" --since "$J_SINCE" --no-pager 2>&1 \
    | grep -a -i -E "$MATCH_RE" > "$out" || true
process_source "$JOURNAL_UNIT" "$out" journal

# Advance the cursor to this run's START: strictly forward, no gaps.
# Everything written during this run (after a source was scraped) has a
# timestamp >= NOW, so the next run's --since NOW re-fetches it; the
# refetch overlap is folded exactly by each source's boundary record
# (see process_source).
printf '%s' "$NOW" > "$CURSOR"
