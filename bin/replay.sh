#!/usr/bin/env bash
# The conformance replay, as run inside the runner image.
#
# ── THIS IS THE CALLER THAT DID NOT EXIST, TWICE (micro-org#439, micro-org#537) ───────────────
#
# Both ends of the conformance gate were built and never joined: the corpus, the comparator,
# `src/publish.ts`, beacon's `POST /v1/conformance` and the per-suite gate input were all complete
# on 2026-08-04 and `conformance_runs` was empty because NOTHING CALLED ANY OF IT. The compose
# runner that closed that was then left behind by the Kubernetes migration, and the corpus stopped
# being replayed on 2026-08-18 — so `HearthConformanceVectorsFailing` went back to being green by
# never being asked a question, which is the same defect arriving by a different route.
#
#   replay.sh once   compare, publish, exit with the comparison's status
#   replay.sh loop   the above, then again every CF_CONFORMANCE_INTERVAL seconds, for ever
#
# `once` is the image's CMD and is what the CronJob runs. `loop` exists for a human running this
# by hand, and for any host that has no scheduler of its own.
#
# ── WHAT THIS NO LONGER DOES, AND WHY THAT IS THE IMPROVEMENT ────────────────────────────────
#
# The compose version fetched and hard-reset a bind-mounted checkout to `origin/main` on every
# replay, then read `packageManager` out of it and asked npm for exactly that pnpm before it could
# compare anything. Both existed to make a mutable host directory behave like an artefact. The
# image IS the artefact: its digest answers "which corpus was that", `node_modules` is installed at
# build time by a pinned pnpm, and the tree is read-only at runtime.
set -uo pipefail

MODE=${1:-once}
INTERVAL=${CF_CONFORMANCE_INTERVAL:-86400}

# The corpus and the base are a matched pair and are deliberately not independently configurable:
# a corpus recorded against one base and compared against another reports every difference as
# breaking, which is a loud way of saying nothing.
#
# MAINNET ONLY, and that is not an oversight. There is one corpus and it was recorded against
# mainnet. Chain id is contract rather than gauge in it — `0x1cf3` mainnet, `0x1cf4` testnet — so
# pointing this at testnet reports a breaking difference that means "wrong estate" and nothing
# else. Testnet needs its own recorded corpus before it can be replayed.
CORPUS=corpus-micro/
BASE=micro

REPO=${CF_CONFORMANCE_DIR:-/app}
BEACON_URL=${CF_BEACON_URL:-http://beacon:4000}

log() { printf '%s conformance-replay: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

replay_once() {
  log "$BASE against $CORPUS (apex ${CONFORMANCE_MICRO_APEX:-unset}, image ${CF_CONFORMANCE_IMAGE_REF:-unrecorded})"

  # ── THE ACCOUNT IS REQUIRED, AND A SKIP IS WHY ──────────────────────────────────────────────
  #
  # Five of the eight suites sign in. Without an account they SKIP — beacon refuses to derive
  # `pass` from zero comparisons, so the run stays honest — and the estate ends up with a replay
  # that runs daily, publishes, clears every alert and compares barely anything. That is a subtler
  # restatement of micro-org#439, so it is refused here rather than reached.
  if [ -z "${CONFORMANCE_ACCOUNT:-}" ]; then
    log 'CONFORMANCE_ACCOUNT is unset; five of the eight suites would skip and the replay would certify almost nothing'
    return 78
  fi

  local args=(compare --corpus "$CORPUS" --base "$BASE")
  [ "${CF_CONFORMANCE_PUBLISH:-1}" = 1 ] && args+=(--beacon "$BEACON_URL")

  # The token and the account reach the harness through the ENVIRONMENT and never through argv.
  # `--beacon-token` reads `BEACON_TOKEN` for exactly this reason: a credential on a command line
  # is visible in `ps` to everything sharing the namespace, and is kept by every log that captures
  # a command.
  ( cd "$REPO" && node --import tsx src/cli.ts "${args[@]}" )
}

case "$MODE" in
  once)
    replay_once
    exit $?
    ;;
  loop)
    while true; do
      replay_once
      status=$?
      # ── A BREAKING DIFFERENCE MUST NOT KILL THE RUNNER ─────────────────────────────────────
      #
      # It is tempting to exit non-zero and let the restart policy express the failure. It would be
      # wrong: the difference would then be reported by a crash-loop, the next replay would run in
      # seconds rather than tomorrow, and the estate would hammer identity with sign-ins for as
      # long as the divergence lasted. The divergence is already published — a `fail` row in
      # `conformance_runs` and a non-zero `beacon_conformance_vectors{result="failed"}`, which is
      # what `HearthConformanceVectorsFailing` reads. The runner's job is to keep asking.
      if [ "$status" -eq 0 ]; then
        log "no breaking difference; next replay in ${INTERVAL}s"
      else
        log "comparison exited $status — see beacon for the per-suite verdict; next replay in ${INTERVAL}s"
      fi
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "replay.sh: unknown mode '$MODE' (want: once | loop)" >&2
    exit 64
    ;;
esac
