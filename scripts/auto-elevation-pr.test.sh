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
# matter on the production hop (`--add-reviewer`) and the ones that must NOT
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
ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
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
  unset GH_PR_LIST_JSON GH_LIST_FAIL GH_CREATE_FAIL GH_EDIT_FAIL
  unset ELEVATION_HEAD ELEVATION_BASE ELEVATION_REVIEWER ELEVATION_CHECKS_RUN ELEVATION_MAX_SUBJECTS
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
logged "--add-reviewer sperezl1" || fail "4 sperezl1 is requested" "$(dump)"
ok "production hop: requests sperezl1"

# ---- 5. the staging hop must NOT ---------------------------------------------
# The exception is the point of the table in ENG-3180.  A reviewer request on
# every dev->staging elevation would train him to ignore the notification, and
# then he misses the production one.
reset
ELEVATION_HEAD=dev ELEVATION_BASE=staging run
not_logged "add-reviewer" || fail "5 staging hop requests nobody" "$(dump)"
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
GH_EDIT_FAIL='GraphQL: Could not resolve to a User with the login of sperezl1.'
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
logged "--add-reviewer sperezl1" || fail "18 a drafted production hop still requests the reviewer" "$(dump)"
ok "production hop: opened as a DRAFT, and still requests sperezl1"

printf '\n%s checks passed\n' "$pass"
