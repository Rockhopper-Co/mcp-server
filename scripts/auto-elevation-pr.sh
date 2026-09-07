#!/usr/bin/env bash
#
# Open the "elevate to <base>" pull request when <head> has run ahead of it.
# ENG-3180.
#
# David, 2026-08-23: "can we add controls to github to always automatically open
# an 'elevate to <branch>' pr whenever there is a disparity? for the prod one, it
# should request a review from sperezl1".  These were opened by hand until now,
# and on 2026-08-23 an afternoon of fixes sat on `dev` with nothing tracking
# them.
#
# WHY A SHELL SCRIPT AND NOT INLINE YAML.  A workflow that inlines its decisions
# in `run:` blocks cannot be executed anywhere except GitHub's runners, so its
# only test is production.  Everything that DECIDES lives here, where
# `auto-elevation-pr.test.sh` drives it against a real git repository with `gh`
# stubbed on PATH.  The workflow next door only supplies inputs and a token.
#
# WHAT IT WILL NEVER DO.  It never merges an elevation, never marks one ready,
# and never changes the draft state of one that is already open.  An open
# elevation pull request is the release sitting in its normal state, not a task
# anybody is late on.
#
# IT DOES NOW CLOSE AND REOPEN ONE PAIR, and only one — `dev` -> `staging`,
# ENG-3502, David 2026-08-27.  Section 2a carries the ruling, what it rejected
# and why.  What comes back is the same pull request number, the same branches
# and the same draft state; the close is how an `opened`-class event is emitted,
# never a disposition on the release.
#
# That paragraph used to say "never closes an elevation" too, and ENG-3437 made
# the second half false on 2026-08-26: the `staging` -> `main` elevation is now
# CREATED as a draft (see section 4).  Marking it READY is the human QA signal
# that starts the test suites, and that move stays a human's — which is the
# whole point of opening it drafted.
#
#     ELEVATION_HEAD=dev ELEVATION_BASE=staging bash scripts/auto-elevation-pr.sh
#
# Inputs, all through the environment.  A branch name is attacker-controlled
# text and must never be interpolated into a shell script by the workflow
# templater — the same reason `scripts/check-elevation.sh` in mcp-gateway reads
# its head ref from `env:`.
#
#   ELEVATION_HEAD        branch that may have run ahead        (required)
#   ELEVATION_BASE        branch it would be elevated into      (required)
#   ELEVATION_REVIEWER    request a review from this login      (optional)
#   ELEVATION_CHECKS_RUN  "true" only when a GitHub App token
#                         opened the pull request; anything
#                         else puts the no-checks warning in
#                         the body                              (default false)
#   ELEVATION_MAX_SUBJECTS  how many commit subjects to list    (default 60)
#   ELEVATION_REMOTE      remote to read the branches from      (default origin)
#   ELEVATION_PUSHED_REF  the branch whose push triggered this
#                         run, empty for cron and dispatch.
#                         Section 2a refreshes the standing
#                         elevation only when this equals
#                         ELEVATION_HEAD — i.e. only when new
#                         content actually landed on it        (default empty)
#
set -euo pipefail

head_ref="${ELEVATION_HEAD:-}"
base_ref="${ELEVATION_BASE:-}"
reviewer="${ELEVATION_REVIEWER:-}"
checks_run="${ELEVATION_CHECKS_RUN:-false}"
max_subjects="${ELEVATION_MAX_SUBJECTS:-60}"
remote="${ELEVATION_REMOTE:-origin}"
pushed_ref="${ELEVATION_PUSHED_REF:-}"

die() { printf '::error::%s\n' "$*" >&2; exit 1; }

# An empty ELEVATION_BASE would build the range `refs/remotes/origin/..dev`,
# which git reads without complaint.  Refuse rather than guess.
[ -n "$head_ref" ] || die "ELEVATION_HEAD is empty — refusing to guess which \
branch has run ahead."
[ -n "$base_ref" ] || die "ELEVATION_BASE is empty — refusing to guess what to \
elevate into."
[ "$head_ref" != "$base_ref" ] || die "ELEVATION_HEAD and ELEVATION_BASE are \
both \`$head_ref\`. A branch cannot be elevated into itself."

# --- 1. is there anything to elevate? ----------------------------------------
# Fetch the two branches by name rather than trusting the checkout to have them.
# `actions/checkout` writes a single-branch refspec by default, so
# `refs/remotes/origin/staging` may simply not exist in the workspace — and a
# missing ref is not an error to `rev-list`'s eye, it is a different range.
#
# A FETCH FAILURE MUST GO RED.  If a branch is renamed or typo'd, the fetch
# fails; treating that as "0 commits ahead" would make this workflow a silent,
# permanent no-op indistinguishable from a repository with nothing to promote.
git fetch --quiet --no-tags "$remote" \
    "+refs/heads/$head_ref:refs/remotes/$remote/$head_ref" \
    "+refs/heads/$base_ref:refs/remotes/$remote/$base_ref" \
  || die "could not fetch \`$head_ref\` and \`$base_ref\` from \`$remote\`. \
One of them probably does not exist under that name. Refusing to report \
\"nothing to elevate\" on the strength of a failed fetch."

range="refs/remotes/$remote/$base_ref..refs/remotes/$remote/$head_ref"
ahead="$(git rev-list --count "$range")"

if [ "$ahead" -eq 0 ]; then
  echo "\`$head_ref\` is level with \`$base_ref\` — nothing to elevate."
  exit 0
fi
echo "\`$head_ref\` is $ahead commits ahead of \`$base_ref\`."

# --- 2. is one already open? -------------------------------------------------
# THIS IS THE HALF THAT MATTERS.  A pull request tracks its head BRANCH, so the
# open elevation already contains every commit pushed since it was opened and
# will contain every one pushed after.  Opening a second is not a duplicate
# notification, it is two pull requests for one promotion — each with its own
# checks and its own reviewers, and no way to tell which one is the real ship.
#
# On the day this shipped all seven repositories already had an open
# `staging` -> `main` elevation, so this is the branch that runs on day one, not
# an edge case.
#
# FAIL CLOSED.  If the query itself fails — rate limit, permissions, an outage —
# the answer is unknown, and "unknown" must never resolve to "no, open another
# one".  `set -e` would already abort on the failed substitution; this says why.
if ! existing="$(gh pr list --base "$base_ref" --head "$head_ref" --state open \
                   --json number --jq '.[0].number // empty')"; then
  die "could not ask GitHub whether an elevation is already open for \
\`$head_ref\` -> \`$base_ref\`. Refusing to open one blind — a second elevation \
for the same promotion is worse than a late one."
fi

if [ -n "$existing" ]; then
  # --- 2a. refresh the standing `dev` -> `staging` elevation -----------------
  # ENG-3502.  David, 2026-08-27: "option A plus the full suite."
  #
  # THE DEFECT.  A pull request tracks its head BRANCH, so every merge into
  # `dev` after the elevation opened arrives as a `synchronize` — and the three
  # gate workflows (`ci.yml`, `coverage.yml`, `postman-drift.yml`) all carry
  # `github.event.action != 'synchronize' || !contains(fromJSON('["dev",
  # "staging"]'), github.head_ref)`, which is ENG-3437 refusing to re-run the
  # suite on a standing elevation.  Correct in isolation, and combined with an
  # auto-opened, never-closed elevation it means gate 3 can only ever fire
  # against whatever `dev` held at open time.  Measured on frontend #1658: 29
  # commits reached `staging` with every substantive check SKIPPED.
  #
  # THE FIX, and it is deliberately not in the workflows.  A close followed by a
  # reopen emits `reopened`, which is in all three `types:` lists and is not a
  # `synchronize` — so the gate fires against the branch's real tip with the
  # ENG-3437 leg untouched, still protecting `staging` -> `main` and every
  # feature pull request into `staging` or `main`.
  #
  # WHAT DAVID REJECTED: exempting `dev` -> `staging` from the synchronize leg
  # (B — edits the leg, and re-runs on every intermediate merge), debouncing on
  # a timer (C — machinery, and no human waits on a schedule), and accepting the
  # hole with a note in the header (D — makes manual QA the detector, which is
  # what ENG-3139 set out to stop).
  #
  # FOUR CONDITIONS, each load-bearing:
  #   - the PAIR is `dev` -> `staging`.  `staging` -> `main` opens as a draft
  #     (ENG-3437) and its gate fires when a human marks it ready; reopening it
  #     would start nothing while it is a draft, and would re-run the whole
  #     suite if it were ready — the 58% of Actions minutes ENG-3437 reclaimed.
  #   - the head branch is what was just PUSHED.  That is the only signal here
  #     that new content exists.  On cron and `workflow_dispatch` the standing
  #     elevation is left alone, so the daily backstop cannot churn it.
  #   - an App token is in hand.  A close/reopen performed with `GITHUB_TOKEN`
  #     starts no workflows at all, so it would be pure notification noise
  #     dressed as a gate — exactly the empty-check-list confusion this script
  #     already warns about in the body.
  #   - a pull request is already open.  With none open the create path below
  #     emits `opened` on its own and this whole branch is unnecessary.
  #
  # WHAT IT DOES NOT FIX: a push whose refresh run is cancelled or fails leaves
  # that commit ungated until the next push into `dev`.  The gate is only ever
  # as current as the last successful refresh.
  if [ "$head_ref" = "dev" ] && [ "$base_ref" = "staging" ] \
     && [ "$checks_run" = "true" ] && [ "$pushed_ref" = "$head_ref" ]; then
    refresh_err="$(mktemp)"
    echo "#$existing tracks \`$head_ref\` -> \`$base_ref\` and \`$head_ref\` just \
moved. Closing and reopening it so the gate fires on what it now carries \
(ENG-3502)."

    # CLOSE FIRST, AND GO RED IF IT REFUSES.  A failed close leaves the
    # elevation open and untouched, which is the safe half of this operation —
    # the gate stays stale, nothing is lost, and the next push tries again.
    if ! gh pr close "$existing" 2>"$refresh_err"; then
      cat "$refresh_err" >&2
      die "could not close #$existing to refresh it (reason above). It is still \
OPEN and still tracks \`$head_ref\` -> \`$base_ref\`; only its checks are stale, \
and they were already stale before this run. Nothing was lost."
    fi

    # THE DANGEROUS HALF.  Between these two calls the promotion is tracked by
    # nothing.  A reopen that fails must be the loudest thing this script can
    # say, because a silently-closed elevation looks exactly like a promotion
    # nobody has started — and the cron will not fix it: `gh pr list --state
    # open` will report none, so the next run OPENS A SECOND pull request for a
    # promotion that already has one sitting closed.
    if ! gh pr reopen "$existing" 2>"$refresh_err"; then
      cat "$refresh_err" >&2
      die "#$existing IS NOW CLOSED and could not be reopened (reason above). \
Nothing is tracking \`$head_ref\` -> \`$base_ref\` until somebody reopens it by \
hand. Do that rather than opening a new one, so the discussion and the review \
history survive."
    fi
    echo "reopened #$existing — the gate runs against \`$head_ref\`'s current tip."
    exit 0
  fi

  echo "#$existing is already open for \`$head_ref\` -> \`$base_ref\`, and it \
tracks the branch — nothing to do."
  exit 0
fi

# --- 3. compose the body ------------------------------------------------------
body="$(mktemp)"
{
  printf '`%s` is **%s commits** ahead of `%s`. Opened automatically (ENG-3180) \
because the two branches diverged; nothing here has been merged, closed or \
marked ready by automation, and nothing will be.\n\n' \
    "$head_ref" "$ahead" "$base_ref"

  # THE WARNING GOES IN THE BODY, NOT THE LOG.  Nobody opens the Actions log
  # before merging an elevation; they look at the check list on the pull
  # request.  An EMPTY check list and a PASSING check list look identical at a
  # glance, and that confusion is the exact failure this project keeps paying
  # for — so when the checks genuinely did not start, it has to say so where the
  # decision is made.
  #
  # And it has to come OFF once they do run.  A warning that is always present
  # is wallpaper, and is not read on the day it is true.
  if [ "$checks_run" != "true" ]; then
    printf '> [!WARNING]\n'
    printf '> **No checks will run on this pull request. An empty check list \
below means the tests were never started — it does not mean they passed.**\n'
    printf '>\n'
    printf '> GitHub Actions opened this using the default `GITHUB_TOKEN`, and \
GitHub deliberately refuses to start `pull_request` workflows for anything that \
token creates, so that a workflow cannot trigger itself forever.\n'
    printf '>\n'
    printf '> **Before merging, start the suite by hand:** the repository'"'"'s \
Actions tab -> its test workflow -> **Run workflow** -> pick `%s`.\n' "$head_ref"
    printf '>\n'
    printf '> This warning disappears on its own once `PACKAGE_SYNC_APP_ID` and \
`PACKAGE_SYNC_PRIVATE_KEY` exist as Actions secrets in this repository and the \
App is installed on it. No code change is needed on that day — see ENG-3180.\n\n'
  fi

  printf '## Commits\n\n'
  # Merge commits are counted in the title (they are real commits on the branch)
  # but their subjects are "Merge pull request #123 from ..." and carry nothing,
  # so the readable list skips them and the truncation maths follows the list.
  listed="$(git rev-list --count --no-merges "$range")"
  git log --no-merges --format='- %s' --max-count="$max_subjects" "$range"
  if [ "$listed" -gt "$max_subjects" ]; then
    # NOT a list item: the test counts subject bullets, and a truncation
    # notice that looks like one makes the cap unassertable.
    printf '\n_…and %s more commits._\n' "$((listed - max_subjects))"
  fi
} > "$body"

# --- 4. open it ---------------------------------------------------------------
# ENG-3437, David 2026-08-26 — the PRODUCTION hop opens as a DRAFT, and no other
# hop does.
#
# Every test workflow triggers on `pull_request: branches: [dev, staging, main]`,
# so a standing elevation used to re-run the whole suite on every push into its
# head branch.  Measured org-wide over the 14 days to 2026-08-26: 58% of all
# Actions minutes (13,431 of 23,128) came from runs on these two pull requests.
# Opened as a draft, the `staging` -> `main` elevation runs NOTHING until a human
# marks it ready — and that click is the QA signal, which is the moment somebody
# is actually waiting on the answer.
#
# `dev` -> `staging` deliberately stays NON-draft: David merges those in ~110s
# median (30 pull requests since 2026-08-23) and does that hop ~100x a fortnight,
# so a draft would add a click to the busiest hop for no gain.  ENG-3437 gates
# the suite on that leg a different way — one run at `opened`, none on
# `synchronize`.
#
# Gated on the PAIR, not on the base alone, because `staging` -> `main` is the
# matrix leg that exists; a hand-run `dev` -> `main` is not a configured
# promotion and is left alone rather than silently drafted.
create_args=(--base "$base_ref" --head "$head_ref"
             --title "elevate to $base_ref — $ahead commits"
             --body-file "$body")
if [ "$head_ref" = "staging" ] && [ "$base_ref" = "main" ]; then
  create_args+=(--draft)
fi

err="$(mktemp)"
if ! url="$(gh pr create "${create_args[@]}" 2>"$err")"; then
  # A LOST RACE IS THE CORRECT OUTCOME, NOT A FAILURE.  `concurrency` in the
  # workflow makes two simultaneous runs rare rather than impossible — a cron
  # and a push can be in flight together — and GitHub refusing the second
  # create is precisely the protection working.
  #
  # Narrow on purpose.  A blanket `|| true` here would make a permissions
  # failure look identical to a successful no-op, which is the shape of every
  # silent-failure incident in this codebase.
  if grep -qi 'already exists' "$err"; then
    echo "another run opened it first — nothing to do."
    exit 0
  fi
  # MEASURED 2026-08-23, and it is the day-one state of every repository here:
  # `can_approve_pull_request_reviews` reads FALSE on all seven, which is the
  # single "Allow GitHub Actions to create and approve pull requests" checkbox.
  # With it off, the `GITHUB_TOKEN` fallback cannot open anything.  Say exactly
  # where the switch is rather than making somebody decode a GraphQL string —
  # agents are barred from changing repository settings, so a human reads this.
  if grep -qi 'not permitted to create' "$err"; then
    cat "$err" >&2
    die "this repository does not allow GitHub Actions to open pull requests, \
so the fallback path cannot work here. Fix EITHER way: Settings -> Actions -> \
General -> Workflow permissions -> tick \"Allow GitHub Actions to create and \
approve pull requests\"; or add \`PACKAGE_SYNC_APP_ID\` and \
\`PACKAGE_SYNC_PRIVATE_KEY\` as Actions secrets here and install the \
package-sync App on this repository with pull-request write, which is the \
better fix because a pull request opened by the App also RUNS ITS CHECKS. \
ENG-3180."
  fi
  cat "$err" >&2
  die "\`gh pr create\` failed for \`$head_ref\` -> \`$base_ref\` (its reason is \
printed above)."
fi
echo "opened $url"

# --- 5. the production hop only ----------------------------------------------
# `dev` -> `staging` requests nobody.  A review request on every staging
# elevation trains the reviewer to dismiss the notification, and then the
# production one goes past unread.
if [ -n "$reviewer" ]; then
  # REST, NOT `gh pr edit`, AND THAT IS THE WHOLE OF ENG-3987.  `gh pr edit`
  # resolves the pull request through a GraphQL lookup that asks for
  # `repository.pullRequest.projectCards`.  GitHub has sunset Projects
  # (classic), so that field now returns an error AND nulls the entire
  # `pullRequest` object with it — the command fails before it can send
  # anything, whatever you asked it to change.  Nothing here has ever touched a
  # project.
  #
  # THIS ONE HAD NEVER FIRED, WHICH IS WHY IT WAS INVISIBLE.  `$reviewer` is
  # empty on the `dev` -> `staging` hop, and no fresh `staging` -> `main`
  # elevation has opened here since the sunset — so this was a latent copy of a
  # measured outage (backend #2677, run 33483694322) sitting on the ONE hop that
  # ships to production.  It would have surfaced the first time a production
  # elevation opened, which is the worst possible moment to discover it.
  #
  # THE VERSION FIX IS THE WEAKER ONE.  `gh` >= 2.73.0 strips `projectCards`
  # from the query when its detector reports Projects v1 unsupported
  # (`pkg/cmd/pr/shared/finder.go`), and that detector always says unsupported
  # against github.com — so a new enough `gh` does work.  But the runner takes
  # whatever `gh` its image ships, that block is marked for deletion upstream
  # (`TODO projectsV1Deprecation`), and the next deprecation of a field we never
  # asked for lands exactly the same way.  Not calling the broken path is the
  # fix.
  #
  # SAME PERMISSION.  `pull-requests: write` is what `--add-reviewer` needed and
  # what this endpoint needs; the workflow's `permissions:` block does not
  # change.  `$url` ends in the number, which is what the endpoint wants.
  if ! gh api --method POST \
         "repos/{owner}/{repo}/pulls/${url##*/}/requested_reviewers" \
         -f "reviewers[]=$reviewer" --silent 2>"$err"; then
    cat "$err" >&2
    # LOUD, and after the fact.  The pull request is already open and stays
    # open — that part succeeded and is the greater share of the value.  What
    # must not happen is this failing quietly, because a production elevation
    # with no reviewer looks exactly like one nobody has got to yet.
    #
    # Usual cause: `$reviewer` has no push access on this repository, so GitHub
    # refuses to make them a requested reviewer. Fix it by granting access, not
    # by removing the request.
    die "opened $url but could NOT request a review from \`$reviewer\` (reason \
above). The pull request is open and correct; only the review request is \
missing. Add it by hand on $url, and grant \`$reviewer\` push access on this \
repository so the next one works."
  fi
  echo "requested a review from $reviewer"
fi
