#!/usr/bin/env bash
#
# Attack auto-elevation-pr.sh in a throwaway repository.  ENG-3180.
#
#     bash scripts/auto-elevation-pr.test.sh
#
# Not wired into `npm test`: it builds a git repository in a temp dir, and the
# repo it lives in may not have a node toolchain at all (parser is C#).  It is a
# hand-run proof, and CI runs it too — `auto-elevation-pr.yml` calls it before
# it calls the script for real, so a broken decision table cannot open a pull
# request.
#
# THE CASE IT EXISTS FOR is case 3.  Every one of the seven repositories already
# has an open `staging` -> `main` elevation on the day this ships, and
# `dev` -> `staging` is level in all seven — so "an open pull request already
# exists, do nothing" is not an edge case here, it is the ONLY path that runs on
# day one.  A second elevation pull request for a pair that already has one is
# the specific damage this whole file exists to prevent: two pull requests for
# one promotion, each with its own checks, neither obviously the real one.
#
# `gh` is stubbed on PATH rather than mocked inside the script, so the arguments
# the script really builds are what gets asserted — including the ones that only
# matter on the production hop (the reviewer request) and the ones that must NOT
# appear on the staging hop.  `git` is real, against a real repository, so the
# commit-counting is not simulated either.
#
set -euo pipefail
export PRE_PUSH_QUIET=1

SCRIPT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/auto-elevation-pr.sh}"
[ -f "$SCRIPT" ] || { echo "no such script: $SCRIPT" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
attacks=0
# `attacks` is counted off the `attack:` prefix the ATTACK cases give their
# `ok` message, so neither number in the summary can drift from the cases that
# actually ran.  ENG-4065 — the workflow header used to state both by hand, and
# every one of the nine repositories carrying it had them wrong.
ok()   {
  pass=$((pass + 1))
  case "$1" in attack:*) attacks=$((attacks + 1)) ;; esac
  printf '  ok   %s\n' "$1"
}
fail() { printf '  FAIL %s\n' "$1" >&2; printf '       %s\n' "${2:-}" >&2; exit 1; }

# ---- a stub `gh` that records what it was asked to do ------------------------
# Behaviour is driven entirely by environment variables the cases set, so one
# stub covers "no open pull request", "one already open", "create races another
# run", and "the reviewer request is refused".
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
sub="${1:-}${2:+ $2}"
case "$sub" in
  "pr list")
    if [ -n "${GH_LIST_FAIL:-}" ]; then
      printf '%s\n' "$GH_LIST_FAIL" >&2
      exit 1
    fi
    # The script asks for `--json number --jq ...`; answer with the real jq so
    # the filter itself is under test, not just the fact that one was passed.
    json="${GH_PR_LIST_JSON:-[]}"
    filter='.[0].number // empty'
    prev=''
    for a in "$@"; do
      if [ "$prev" = "--jq" ]; then filter="$a"; fi
      prev="$a"
    done
    printf '%s' "$json" | jq -r "$filter"
    ;;
  "pr create")
    # Record the body the script composed, so its text can be asserted.
    prev=''
    for a in "$@"; do
      if [ "$prev" = "--body-file" ]; then cp "$a" "$GH_BODY"; fi
      if [ "$prev" = "--title" ]; then printf '%s' "$a" > "$GH_TITLE"; fi
      prev="$a"
    done
    if [ -n "${GH_CREATE_FAIL:-}" ]; then
      printf '%s\n' "$GH_CREATE_FAIL" >&2
      exit 1
    fi
    printf '%s\n' "https://github.com/Rockhopper-Co/stub/pull/99"
    ;;
  "pr edit")
    if [ -n "${GH_EDIT_FAIL:-}" ]; then
      printf '%s\n' "$GH_EDIT_FAIL" >&2
      exit 1
    fi
    ;;
  "api "*|"api")
    # ENG-3987 — the reviewer request goes through REST now, because
    # `gh pr edit` cannot resolve a pull request at all (see the last two
    # cases).  Failed independently of `pr edit` so that "the reviewer was
    # refused" and "the whole lookup is broken" stay two distinguishable
    # outcomes, which is exactly the distinction the old stub could not make.
    if [ -n "${GH_API_FAIL:-}" ]; then
      printf '%s\n' "$GH_API_FAIL" >&2
      exit 1
    fi
    ;;
  # ENG-3502.  The refresh is two calls and the ORDER matters, so both are
  # recorded (every call is, at the top of this stub) and each can be failed
  # independently — a failed reopen leaves the elevation closed, which is the
  # one state this script can create that is worse than the bug it fixes.
  "pr close")
    if [ -n "${GH_CLOSE_FAIL:-}" ]; then
      printf '%s\n' "$GH_CLOSE_FAIL" >&2
      exit 1
    fi
    ;;
  "pr reopen")
    if [ -n "${GH_REOPEN_FAIL:-}" ]; then
      printf '%s\n' "$GH_REOPEN_FAIL" >&2
      exit 1
    fi
    ;;
  *) printf 'stub gh: unhandled: %s\n' "$*" >&2; exit 127 ;;
esac
STUB
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

# ---- a repository shaped like any of the seven ------------------------------
# `origin` is a real bare repo so that the script's own `git fetch` runs for
# real.  Three branches, and `staging` deliberately left behind `dev`.
origin="$tmp/origin.git"
work="$tmp/work"
git init --quiet --bare "$origin"
git init --quiet "$work"
cd "$work"
git config user.email t@example.com
git config user.name test
git config commit.gpgsign false
echo seed > file.txt
git add -A && git commit --quiet -m "seed"
git remote add origin "$origin"
git push --quiet origin HEAD:refs/heads/main
git push --quiet origin HEAD:refs/heads/staging
git push --quiet origin HEAD:refs/heads/dev

# Three commits onto `dev` only.  `staging` is now 3 behind, `main` is level
# with `staging`.
for n in 1 2 3; do
  echo "$n" >> file.txt
  git commit --quiet -am "feat: change number $n"
done
git push --quiet origin HEAD:refs/heads/dev
git fetch --quiet origin

# ---- the harness ------------------------------------------------------------
# Each case runs the script in a clean environment and captures everything.
run() {
  : > "$tmp/gh.log"
  : > "$tmp/gh.body"
  : > "$tmp/gh.title"
  set +e
  env -i \
    PATH="$PATH" HOME="$HOME" \
    GH_LOG="$tmp/gh.log" GH_BODY="$tmp/gh.body" GH_TITLE="$tmp/gh.title" \
    GH_PR_LIST_JSON="${GH_PR_LIST_JSON:-[]}" \
    GH_LIST_FAIL="${GH_LIST_FAIL:-}" \
    GH_CREATE_FAIL="${GH_CREATE_FAIL:-}" \
    GH_EDIT_FAIL="${GH_EDIT_FAIL:-}" \
    GH_API_FAIL="${GH_API_FAIL:-}" \
    GH_CLOSE_FAIL="${GH_CLOSE_FAIL:-}" \
    GH_REOPEN_FAIL="${GH_REOPEN_FAIL:-}" \
    ELEVATION_PUSHED_REF="${ELEVATION_PUSHED_REF:-}" \
    ELEVATION_HEAD="${ELEVATION_HEAD:-}" \
    ELEVATION_BASE="${ELEVATION_BASE:-}" \
    ELEVATION_REVIEWER="${ELEVATION_REVIEWER:-}" \
    ELEVATION_CHECKS_RUN="${ELEVATION_CHECKS_RUN:-}" \
    ELEVATION_MAX_SUBJECTS="${ELEVATION_MAX_SUBJECTS:-}" \
    bash "$SCRIPT" > "$tmp/out" 2> "$tmp/err"
  rc=$?
  set -e
}

reset() {
  unset GH_PR_LIST_JSON GH_LIST_FAIL GH_CREATE_FAIL GH_EDIT_FAIL GH_CLOSE_FAIL GH_REOPEN_FAIL GH_API_FAIL
  unset ELEVATION_HEAD ELEVATION_BASE ELEVATION_REVIEWER ELEVATION_CHECKS_RUN ELEVATION_MAX_SUBJECTS
  unset ELEVATION_PUSHED_REF
}

logged()     { grep -q -- "$1" "$tmp/gh.log"; }
not_logged() { ! grep -q -- "$1" "$tmp/gh.log"; }
dump()       { printf 'rc=%s\n--- stdout\n%s\n--- stderr\n%s\n--- gh calls\n%s\n' \
                 "$rc" "$(cat "$tmp/out")" "$(cat "$tmp/err")" "$(cat "$tmp/gh.log")"; }

echo "auto-elevation-pr.sh"

# ---- 1. no disparity is a clean no-op ---------------------------------------
# `main` and `staging` are level.  Nothing to elevate, and in particular nothing
# to open — an empty elevation pull request is worse than none.
reset
ELEVATION_HEAD=staging ELEVATION_BASE=main ELEVATION_REVIEWER=sperezl1 run
[ "$rc" -eq 0 ]              || fail "1 level pair exits clean" "$(dump)"
not_logged "pr create"       || fail "1 level pair opens nothing" "$(dump)"
not_logged "pr list"         || fail "1 level pair does not even ask github" "$(dump)"
ok "level pair: exits 0, opens nothing"

# ---- 2. disparity with no open pull request creates one ----------------------
reset
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
[ "$rc" -eq 0 ]                          || fail "2 create exits clean" "$(dump)"
logged "pr create"                       || fail "2 create is attempted" "$(dump)"
logged "--base staging"               || fail "2 base is staging" "$(dump)"
logged "--head dev"                   || fail "2 head is dev" "$(dump)"
[ "$(cat "$tmp/gh.title")" = "elevate to staging — 3 commits" ] \
  || fail "2 title names base and count" "title=$(cat "$tmp/gh.title")"
grep -q "feat: change number 3" "$tmp/gh.body" \
  || fail "2 body lists the commit subjects" "$(cat "$tmp/gh.body")"
ok "disparity, no open pull request: creates one, titled with base + count"

# ---- 3. THE CASE THIS FILE EXISTS FOR ---------------------------------------
# An open pull request already tracks this head->base pair.  It updates itself
# as the head branch moves, so a second one is pure damage.
reset
GH_PR_LIST_JSON='[{"number":2192}]'
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
[ "$rc" -eq 0 ]        || fail "3 existing pull request exits clean" "$(dump)"
logged "pr list"       || fail "3 it actually asked" "$(dump)"
not_logged "pr create" || fail "3 SECOND PULL REQUEST OPENED — idempotency broken" "$(dump)"
grep -q "2192" "$tmp/out" || fail "3 says which pull request it found" "$(dump)"
ok "disparity, pull request already open: opens NOTHING, names the existing one"

# ---- 4. the production hop requests the reviewer ----------------------------
reset
ELEVATION_HEAD=dev ELEVATION_BASE=main ELEVATION_REVIEWER=sperezl1 run
[ "$rc" -eq 0 ]                     || fail "4 reviewer hop exits clean" "$(dump)"
logged "reviewers\[\]=sperezl1" || fail "4 sperezl1 is requested" "$(dump)"
ok "production hop: requests sperezl1"

# ---- 5. the staging hop must NOT ---------------------------------------------
# The exception is the point of the table in ENG-3180.  A reviewer request on
# every dev->staging elevation would train him to ignore the notification, and
# then he misses the production one.
reset
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
not_logged "requested_reviewers" || fail "5 staging hop requests nobody" "$(dump)"
ok "staging hop: requests nobody"

# ---- 6. no app token: the warning is in the BODY ------------------------------
# A log line is invisible to the person deciding whether to merge.  The warning
# has to be where they read.
reset
ELEVATION_CHECKS_RUN=false ELEVATION_HEAD=dev ELEVATION_BASE=staging run
grep -qi "no checks" "$tmp/gh.body" \
  || fail "6 body warns that no checks ran" "$(cat "$tmp/gh.body")"
grep -qi "GITHUB_TOKEN" "$tmp/gh.body" \
  || fail "6 body says WHY no checks ran" "$(cat "$tmp/gh.body")"
grep -qi "Run workflow" "$tmp/gh.body" \
  || fail "6 body says what to do instead" "$(cat "$tmp/gh.body")"
ok "no app token: body carries the plain-language no-checks warning"

# ---- 7. with an app token the warning is absent -------------------------------
# A warning that is always there is wallpaper.  If it never comes off, nobody
# reads it on the day it is true.
reset
ELEVATION_CHECKS_RUN=true ELEVATION_HEAD=dev ELEVATION_BASE=staging run
grep -qi "no checks" "$tmp/gh.body" \
  && fail "7 warning must disappear once checks really run" "$(cat "$tmp/gh.body")"
ok "app token present: no warning"

# ---- 8. ATTACK: two runs race and github refuses the second -------------------
# `concurrency` in the workflow makes this rare, not impossible: a cron and a
# push can land in different concurrency groups.  GitHub refusing a duplicate is
# the CORRECT outcome, so the script must read that refusal as "already done".
reset
GH_CREATE_FAIL='pull request create failed: GraphQL: A pull request already exists for Rockhopper-Co:dev.'
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
[ "$rc" -eq 0 ] || fail "8 lost race is not a failure" "$(dump)"
ok "attack: lost create race reads as already-done, exits 0"

# ---- 9. ATTACK: any OTHER create failure must stay red ------------------------
# The clause above is a narrow escape hatch, not a blanket `|| true`.  If it
# swallowed every failure, a permissions error would look identical to a
# successful no-op — which is the exact shape of "silence is not a measurement".
reset
GH_CREATE_FAIL='GraphQL: Resource not accessible by integration (createPullRequest)'
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
[ "$rc" -ne 0 ] || fail "9 a permissions failure must go red" "$(dump)"
grep -qi "not accessible" "$tmp/err" || fail "9 the real error is surfaced" "$(dump)"
ok "attack: a non-duplicate create failure stays red and prints gh's reason"

# ---- 10. ATTACK: a refused reviewer request must go red ----------------------
# `sperezl1` needs push access on the repository for this to work at all.  If it
# silently no-ops, the production elevation looks reviewed-by-nobody and the
# only signal is a log line nobody opens.
reset
GH_API_FAIL='HTTP 422: Reviews may only be requested from collaborators.'
ELEVATION_HEAD=dev ELEVATION_BASE=main ELEVATION_REVIEWER=sperezl1 run
[ "$rc" -ne 0 ] || fail "10 a refused reviewer request must go red" "$(dump)"
grep -qi "sperezl1" "$tmp/err" || fail "10 the error names the reviewer" "$(dump)"
grep -qi "https://github.com" "$tmp/err" \
  || fail "10 the error links the pull request that IS open" "$(dump)"
ok "attack: refused reviewer request goes red, and still names the open pull request"

# ---- 11. ATTACK: missing inputs refuse rather than guess ----------------------
# An empty `ELEVATION_BASE` interpolated into a revision range is `origin/..dev`
# — which git happily reads as "everything", and the script would open an
# elevation against nothing.
reset
ELEVATION_HEAD=dev run
[ "$rc" -ne 0 ]        || fail "11 missing base refuses" "$(dump)"
not_logged "pr create" || fail "11 missing base opens nothing" "$(dump)"
reset
ELEVATION_BASE=staging run
[ "$rc" -ne 0 ]        || fail "11 missing head refuses" "$(dump)"
ok "attack: a missing head or base refuses instead of guessing"

# ---- 12. ATTACK: an unknown branch refuses rather than reporting zero ---------
# A typo'd branch name makes `git fetch` fail.  Without the check that becomes
# "0 commits ahead" — a silent, permanent no-op that looks exactly like a repo
# with nothing to elevate.
reset
ELEVATION_HEAD=dev ELEVATION_BASE=no-such-branch run
[ "$rc" -ne 0 ]        || fail "12 an unfetchable base refuses" "$(dump)"
not_logged "pr create" || fail "12 an unfetchable base opens nothing" "$(dump)"
ok "attack: an unfetchable branch goes red instead of reading as level"

# ---- 13. a long backlog does not blow the body limit -------------------------
# backend is 786 commits ahead of `main` today.  A body over 65536 characters is
# rejected by the API, which would turn the production elevation — the one that
# matters most — into the only one that never opens.
reset
for n in $(seq 1 40); do
  echo "bulk $n" >> file.txt
  git commit --quiet -am "chore: bulk commit $n"
done
git push --quiet origin HEAD:refs/heads/dev
git fetch --quiet origin
ELEVATION_HEAD=dev ELEVATION_BASE=staging ELEVATION_MAX_SUBJECTS=10 run
[ "$rc" -eq 0 ] || fail "13 long backlog exits clean" "$(dump)"
[ "$(grep -c '^- ' "$tmp/gh.body")" -eq 10 ] \
  || fail "13 the subject list is capped" "$(grep -c '^- ' "$tmp/gh.body") lines"
grep -q "more" "$tmp/gh.body" || fail "13 it says the list was truncated" "$(cat "$tmp/gh.body")"
[ "$(cat "$tmp/gh.title")" = "elevate to staging — 43 commits" ] \
  || fail "13 the TITLE still carries the true count" "title=$(cat "$tmp/gh.title")"
ok "long backlog: subject list capped, count in the title stays true"

# ---- 15. ATTACK: the day-one refusal names the exact switch --------------------
# Measured 2026-08-23: every one of the seven repositories has "Allow GitHub
# Actions to create and approve pull requests" OFF, so this is the FIRST thing
# the fallback path will hit in real life.  A raw GraphQL string in a log is not
# an actionable message for the one person who is allowed to fix it.
reset
GH_CREATE_FAIL='pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest).'
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
[ "$rc" -ne 0 ] || fail "15 a refused create must go red" "$(dump)"
grep -qi "Workflow permissions" "$tmp/err" \
  || fail "15 the error names the settings page" "$(dump)"
grep -qi "PACKAGE_SYNC_APP_ID" "$tmp/err" \
  || fail "15 the error names the better fix too" "$(dump)"
ok "attack: 'Actions may not open pull requests' names both fixes, not a GraphQL string"

# ---- 14. ATTACK: an unanswerable "is one already open?" must fail closed -----
# Rate limit, an outage, a token without `pull-requests: read`.  The answer is
# UNKNOWN, and unknown must never resolve to "no, open another one" — that is
# how one promotion ends up with two pull requests on the day GitHub is already
# having a bad time.
reset
GH_LIST_FAIL='HTTP 403: Resource not accessible by integration'
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
[ "$rc" -ne 0 ]        || fail "14 an unanswerable duplicate check must go red" "$(dump)"
not_logged "pr create" || fail "14 IT OPENED ONE BLIND — fail-closed broken" "$(dump)"
ok "attack: an unanswerable duplicate check fails closed, opens nothing"

# ---- 16. the STAGING hop is not drafted --------------------------------------
# ENG-3437 drafts the production elevation only.  `dev` -> `staging` is merged
# in ~110s median and happens ~100x a fortnight; a draft there would add a click
# to the busiest hop and buy nothing, because that leg is already gated a
# different way (one run at `opened`, none on `synchronize`).
reset
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
[ "$rc" -eq 0 ]        || fail "16 staging hop exits clean" "$(dump)"
logged "pr create"     || fail "16 staging hop opens one" "$(dump)"
not_logged "--draft" || fail "16 STAGING HOP WAS DRAFTED — it must not be" "$(dump)"
ok "staging hop: opened ready, not drafted"

# ---- 17. the gate is the PAIR, not the base ----------------------------------
# `--draft` keys on head=staging AND base=main, which is the matrix leg that
# exists.  A hand-run `dev` -> `main` is not a configured promotion, so it is
# left alone rather than silently drafted — assert that, or a later
# simplification to `base = main` passes unnoticed.
reset
ELEVATION_HEAD=dev ELEVATION_BASE=main ELEVATION_REVIEWER=sperezl1 run
[ "$rc" -eq 0 ]        || fail "17 dev->main exits clean" "$(dump)"
logged "pr create"     || fail "17 dev->main opens one" "$(dump)"
not_logged "--draft" || fail "17 dev->main was drafted — the gate widened to the base" "$(dump)"
ok "dev->main: not drafted — the draft gate is the head/base pair"

# ---- 19. ENG-3502: a push into `dev` REFRESHES the standing elevation --------
# The defect this whole round exists for.  The three gate workflows refuse to
# re-run on a `synchronize` whose head is `dev` or `staging` (ENG-3437), and the
# elevation is opened once and synchronized forever — so gate 3 only ever saw
# whatever `dev` held at open time.  A close followed by a reopen emits
# `reopened`, which is in all three `types:` lists and is not a `synchronize`.
#
# The ORDER is asserted, not just the presence: a reopen recorded before its
# close would mean the pull request ends up closed.
reset
GH_PR_LIST_JSON='[{"number":2192}]'
ELEVATION_HEAD=dev ELEVATION_BASE=staging ELEVATION_CHECKS_RUN=true \
  ELEVATION_PUSHED_REF=dev run
[ "$rc" -eq 0 ]           || fail "19 refresh exits clean" "$(dump)"
logged "pr close 2192"    || fail "19 IT NEVER CLOSED — gate 3 still never fires" "$(dump)"
logged "pr reopen 2192"   || fail "19 IT NEVER REOPENED — the elevation is now closed" "$(dump)"
not_logged "pr create"    || fail "19 refresh must not open a second pull request" "$(dump)"
[ "$(grep -n 'pr close' "$tmp/gh.log" | head -1 | cut -d: -f1)" \
  -lt "$(grep -n 'pr reopen' "$tmp/gh.log" | head -1 | cut -d: -f1)" ] \
  || fail "19 close must come BEFORE reopen" "$(dump)"
ok "push into dev: the standing elevation is closed then reopened, no second one"

# ---- 20. the cron does NOT churn it ------------------------------------------
# `ELEVATION_PUSHED_REF` is empty on cron and `workflow_dispatch`.  Refreshing
# there would re-run the full suite daily against content the gate already saw,
# which is the ENG-3437 burn coming back through a different door.
reset
GH_PR_LIST_JSON='[{"number":2192}]'
ELEVATION_HEAD=dev ELEVATION_BASE=staging ELEVATION_CHECKS_RUN=true run
[ "$rc" -eq 0 ]        || fail "20 cron exits clean" "$(dump)"
not_logged "pr close"  || fail "20 THE CRON CHURNED THE ELEVATION" "$(dump)"
not_logged "pr create" || fail "20 cron opens nothing when one is open" "$(dump)"
ok "cron with no push: leaves the standing elevation alone"

# ---- 21. no App token: no refresh --------------------------------------------
# A close/reopen performed with `GITHUB_TOKEN` starts no workflows at all, so it
# would be notification noise wearing a gate's clothes — the same empty-check-
# list confusion the body warning in case 6 exists to prevent.
reset
GH_PR_LIST_JSON='[{"number":2192}]'
ELEVATION_HEAD=dev ELEVATION_BASE=staging ELEVATION_CHECKS_RUN=false \
  ELEVATION_PUSHED_REF=dev run
[ "$rc" -eq 0 ]       || fail "21 exits clean without an app token" "$(dump)"
not_logged "pr close" || fail "21 refreshed with a token that starts no checks" "$(dump)"
ok "no app token: no refresh, because reopening would start nothing"

# ---- 22. ATTACK: a refused close stays red and leaves it OPEN -----------------
# The safe half.  A failed close changes nothing: the elevation is still open,
# its checks are as stale as they already were, and the next push retries.  It
# must still go red — a silent skip here is a gate that quietly stops firing
# again, which is precisely the bug being fixed.
reset
GH_PR_LIST_JSON='[{"number":2192}]'
GH_CLOSE_FAIL='HTTP 403: Resource not accessible by integration'
ELEVATION_HEAD=dev ELEVATION_BASE=staging ELEVATION_CHECKS_RUN=true \
  ELEVATION_PUSHED_REF=dev run
[ "$rc" -ne 0 ]        || fail "22 a refused close must go red" "$(dump)"
not_logged "pr reopen" || fail "22 IT REOPENED A PULL REQUEST IT NEVER CLOSED" "$(dump)"
grep -qi "still" "$tmp/err" || fail "22 the error says the elevation is still open" "$(dump)"
ok "attack: a refused close goes red and never reaches the reopen"

# ---- 23. ATTACK: a refused REOPEN is the loudest failure here -----------------
# Between the close and the reopen the promotion is tracked by nothing, and the
# cron cannot heal it: `--state open` reports none, so the next run would open a
# SECOND pull request for a promotion that already has one sitting closed.
reset
GH_PR_LIST_JSON='[{"number":2192}]'
GH_REOPEN_FAIL='HTTP 422: Unprocessable Entity'
ELEVATION_HEAD=dev ELEVATION_BASE=staging ELEVATION_CHECKS_RUN=true \
  ELEVATION_PUSHED_REF=dev run
[ "$rc" -ne 0 ]                 || fail "23 a refused reopen must go red" "$(dump)"
grep -q "2192" "$tmp/err"       || fail "23 the error names the closed pull request" "$(dump)"
grep -qi "CLOSED" "$tmp/err"    || fail "23 the error says it is CLOSED" "$(dump)"
grep -qi "by hand" "$tmp/err"   || fail "23 the error says what a human must do" "$(dump)"
ok "attack: a refused reopen goes red, names the number and says it is closed"

# ---- 18. THE PRODUCTION HOP OPENS AS A DRAFT ---------------------------------
# The reason ENG-3437 exists.  With the suites triggering on
# `pull_request: branches: [dev, staging, main]`, a ready `staging` -> `main`
# elevation ran the full suite at `opened` — against the release's FIRST commit,
# before any of it was built — and again on every push into `staging`.  Measured
# 2026-08-12..2026-08-26: 58% of the org's Actions minutes were runs on these two
# standing pull requests.  Drafted, it runs nothing until a human marks it ready,
# and that click is the QA signal.
#
# `staging` is pushed up to `dev`'s tip first: the fixture leaves it level with
# `main`, and a level pair opens nothing (case 1).  This mutates `origin`, so it
# stays last.
reset
git push --quiet origin HEAD:refs/heads/staging
git fetch --quiet origin
ELEVATION_HEAD=staging ELEVATION_BASE=main ELEVATION_REVIEWER=sperezl1 run
[ "$rc" -eq 0 ]                  || fail "18 production hop exits clean" "$(dump)"
logged "pr create"               || fail "18 production hop opens one" "$(dump)"
logged "--draft"                 || fail "18 PRODUCTION HOP IS NOT A DRAFT — the whole suite fires at opened" "$(dump)"
logged "reviewers\[\]=sperezl1" || fail "18 a drafted production hop still requests the reviewer" "$(dump)"
ok "production hop: opened as a DRAFT, and still requests sperezl1"

# ---- 24. the production elevation is NEVER refreshed -------------------------
# ENG-3502 is scoped to the PAIR, not to "any open elevation".
# `staging` -> `main` opens as a draft (ENG-3437): reopening it while drafted
# starts nothing, and reopening it after a human marked it ready re-runs the
# whole suite — the 58% of Actions minutes that round reclaimed.  Gate 4 fires
# on `ready_for_review`, and that click stays a human's.
#
# Runs after case 18, which is what leaves `staging` ahead of `main`.
reset
GH_PR_LIST_JSON='[{"number":3000}]'
ELEVATION_HEAD=staging ELEVATION_BASE=main ELEVATION_REVIEWER=sperezl1 \
  ELEVATION_CHECKS_RUN=true ELEVATION_PUSHED_REF=staging run
[ "$rc" -eq 0 ]        || fail "24 production hop with one open exits clean" "$(dump)"
not_logged "pr close"  || fail "24 THE DRAFT PRODUCTION ELEVATION WAS REFRESHED" "$(dump)"
not_logged "pr create" || fail "24 production hop opens nothing when one is open" "$(dump)"
ok "production hop: never refreshed — gate 4 fires when a human marks it ready"

# ---- 25. THE CASE ENG-3987 EXISTS FOR --------------------------------------
# The production reviewer request must survive a `gh` whose `pr edit` cannot
# resolve a pull request AT ALL.
#
# WHAT HAPPENED.  `gh pr edit` asks for `repository.pullRequest.projectCards` in
# its lookup.  GitHub has sunset Projects (classic), so that field now returns
# an error AND nulls the whole `pullRequest` object with it — the edit fails
# before it can send anything, whatever you asked it to change.  Measured on
# backend run 33483694322, where the same call in the same script broke the
# elevation refresh; fixed there in #2677 and ported here.
#
# WHY IT WAS INVISIBLE HERE.  This line had never fired: `ELEVATION_REVIEWER` is
# empty on the `dev` -> `staging` hop, and no fresh `staging` -> `main`
# elevation has opened since the sunset.  So the break was latent on the ONE hop
# that ships to production, and would have surfaced the first time somebody cut
# a release.
#
# `GH_EDIT_FAIL` here is not an outage being simulated.  It is the STEADY STATE
# of the `gh` on the runner, and this case says the reviewer request must not go
# through a command that has it.  It fails on any implementation that calls
# `gh pr edit`.
reset
GH_EDIT_FAIL='GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience, see: https://github.blog/changelog/2024-05-23-sunset-notice-projects-classic/. (repository.pullRequest.projectCards)'
ELEVATION_HEAD=dev ELEVATION_BASE=main ELEVATION_REVIEWER=sperezl1 run
[ "$rc" -eq 0 ] \
  || fail "25 THE REVIEWER REQUEST STILL GOES THROUGH \`gh pr edit\` — the production hop dies" "$(dump)"
not_logged "pr edit" \
  || fail "25 \`gh pr edit\` was called; its lookup cannot resolve a PR" "$(dump)"
logged "requested_reviewers" || fail "25 the reviewer was not requested at all" "$(dump)"
logged "reviewers\[\]=sperezl1" || fail "25 sperezl1 is no longer the one requested" "$(dump)"
logged "pulls/99"             || fail "25 the request did not name the pull request just opened" "$(dump)"
ok "production reviewer request avoids the broken lookup, and still names sperezl1"

# ---- 26. ATTACK: a genuinely refused reviewer request is still LOUD ---------
# Routing around `gh pr edit` must not route around the ERROR.  A production
# elevation with no reviewer looks exactly like one nobody has got to yet, and
# the only other signal is a log line nobody opens.  Asserted separately from
# case 10 because that case now fails the REST call at the point the script
# reads its exit status — this one proves the message still reaches a human.
reset
GH_API_FAIL='HTTP 422: Reviews may only be requested from collaborators.'
ELEVATION_HEAD=dev ELEVATION_BASE=main ELEVATION_REVIEWER=sperezl1 run
[ "$rc" -ne 0 ] || fail "26 A REFUSED REVIEWER REQUEST EXITED GREEN" "$(dump)"
grep -qi "sperezl1" "$tmp/err" || fail "26 the error names the reviewer" "$(dump)"
grep -qi "collaborators" "$tmp/err" || fail "26 gh's own reason is not printed" "$(dump)"
ok "attack: a refused reviewer request goes red and prints the endpoint's reason"

printf '\n%s checks passed, %s of them attacks\n' "$pass" "$attacks"
