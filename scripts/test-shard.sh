#!/usr/bin/env bash
#
# Run one shard of a package's test files.
#
# Sharding across CI JOBS rather than worker processes within one job is deliberate. The
# suite contains tests whose assertion is "this finished within N milliseconds" -- a poll
# loop under an `Effect.timeoutOrElse` ceiling, for instance -- so their budget is really a
# statement about how loaded the machine is. Workers sharing one runner's cores stretch a
# comfortable 3s wait past a 5s limit, which is how `bun test --parallel` failed in CI while
# passing on a 16-core idle host. A shard gets a runner to itself, so per-test wall clock
# stays what it was serially and only the total divides.
#
# Selection is round-robin over the sorted file list: shard i takes every Nth file. Stateless
# and deterministic, so the same file lands in the same shard on every run, and no measured
# timing table has to be kept in sync with the tests. Balance is therefore approximate --
# good enough when the suite's median file is 1.4s and its slowest is 20s.
#
# Usage: scripts/test-shard.sh <package-dir> <index-from-1> <total-shards>
#
set -euo pipefail

PKG="${1:?usage: test-shard.sh <package-dir> <index> <total>}"
INDEX="${2:?missing shard index (1-based)}"
TOTAL="${3:?missing shard total}"

if ! [[ "$INDEX" =~ ^[0-9]+$ ]] || ! [[ "$TOTAL" =~ ^[0-9]+$ ]] || (( INDEX < 1 || TOTAL < 1 || INDEX > TOTAL )); then
  echo "shard index must be 1..total, got $INDEX of $TOTAL" >&2
  exit 1
fi

cd "$PKG"

mapfile -t all < <(find test -name '*.test.ts' -o -name '*.test.tsx' | sort)
if (( ${#all[@]} == 0 )); then
  echo "no test files under $PKG/test" >&2
  exit 1
fi

files=()
for i in "${!all[@]}"; do
  if (( i % TOTAL == INDEX - 1 )); then
    files+=("${all[i]}")
  fi
done

# An empty shard means more shards than files, which is a configuration mistake rather than
# a pass. Saying so beats a green job that ran nothing.
if (( ${#files[@]} == 0 )); then
  echo "shard $INDEX/$TOTAL selected no files out of ${#all[@]} -- too many shards" >&2
  exit 1
fi

echo "shard $INDEX/$TOTAL: ${#files[@]} of ${#all[@]} file(s) in $PKG"
exec bun test --timeout 30000 --only-failures "${files[@]}"
