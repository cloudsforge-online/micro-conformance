# syntax=docker/dockerfile:1.7
#
# THE CONFORMANCE RUNNER, AS AN IMAGE — micro-org#537.
#
# The replay used to be a `node:22-bookworm` container with a git checkout BIND-MOUNTED into it
# from whichever host was running the estate, and that is what the Kubernetes migration left
# behind: a compose service that is not rendered is simply not there, nothing failed when it was
# not translated, and the corpus stopped being replayed on 2026-08-18 while
# `ConformanceCorpusStale` fired on every suite for a fortnight.
#
# So the harness ships as an image, which is the estate's own rule — release images, not
# checkouts — and it settles three things the bind-mount left open:
#
#   * **"Which corpus was that?"** The old runner answered it with `git fetch && git reset --hard
#     origin/main` on every replay, so the answer was "whatever main was at 04:30". The image
#     digest answers it now, and a rollback is a tag rather than a reset.
#   * **The package manager.** `replay.sh` had to read `packageManager` out of the checkout and ask
#     npm for exactly that pnpm, because `corepack pnpm` refuses to switch versions and
#     `node:22-bookworm` floats its corepack pin underneath the estate. The install happens HERE,
#     once, at a version this file pins.
#   * **The write.** The old container ran as uid 1000 because it wrote `node_modules` into a
#     human's checkout. Nothing is written at runtime now, so it runs as `node` over a read-only
#     tree.
#
# SINGLE CONTEXT, deliberately unlike every service image in the estate: this repository has NO
# runtime dependencies and no `link:` siblings — `package.json` `dependencies` is empty and the
# three devDependencies are `tsx`, `typescript` and `@types/node`. There is nothing for
# `--build-context runtimepkgs=` to supply, and asking for one would be a context nobody reads.

# ----------------------------------------------------------------------------------- deps
FROM node:22-slim AS deps
# Pinned to the `packageManager` field in package.json. When that moves, this moves with it —
# `--frozen-lockfile` below is only as good as the pnpm that reads the lockfile.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# devDependencies INCLUDED, and that is not laziness: `tsx` is how every process in this estate
# runs its TypeScript, and the harness is `node --import tsx src/cli.ts`. A production-only install
# would produce an image that cannot start.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --config.store-dir=/pnpm-store

# ----------------------------------------------------------------------------------- build
# `tsc --noEmit`, for the reason every service Dockerfile in the estate gives: tsx runs the sources
# directly, and what this stage buys is that a type error fails the image build rather than the
# 04:30 replay.
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm typecheck

# ----------------------------------------------------------------------------------- runtime
FROM node:22-slim AS runtime
WORKDIR /app

# No corepack, no pnpm, no build toolchain: nothing at runtime needs them, and this process reaches
# the public internet with an estate credential in its environment.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src

# THE CORPUS IS THE POINT OF THE IMAGE. Without it this is a comparator with nothing to compare,
# and the failure mode would be a green run over zero suites — which is micro-org#439 exactly.
COPY corpus ./corpus
COPY corpus-micro ./corpus-micro

COPY bin/replay.sh /usr/local/bin/replay.sh

USER node

# No secret is baked in and none may be. `CONFORMANCE_SECRETS_FILE`, `BEACON_TOKEN` and
# `CONFORMANCE_ACCOUNT` are supplied at run time; there is no ENV line here on purpose.
ENV NODE_ENV=production

# `once` and not `loop`: in the cluster the schedule belongs to the CronJob, which is the
# orchestrator's own idiom for it, and a container that sleeps for a day is a container whose
# failure to wake up nothing notices. `loop` is still there for a human running this by hand.
ENTRYPOINT ["/usr/local/bin/replay.sh"]
CMD ["once"]
