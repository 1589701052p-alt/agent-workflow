#!/bin/sh
# Stub opencode for RFC-056 cross-clarify e2e.
#
# Drives a 5-round spawn sequence for the A1 happy path:
#
#   Round 1 — designer.first invocation:
#     emit <workflow-output> "initial design".
#   Round 2 — questioner.first invocation:
#     emit <workflow-clarify> with a single question to the user.
#   *** task pauses awaiting_human; user POSTs answers ***
#   Round 3 — designer.second invocation (cross-clarify rerun):
#     prompt should now contain `## External Feedback` (auto-appended by
#     the runner from the user's submitted answers). Stub logs the
#     received prompt to $CROSS_CLARIFY_PROMPT_LOG so the spec can grep.
#   Round 4 — questioner.second invocation (post designer rerun):
#     emit <workflow-output> "all good, no more questions".
#   Round 5 — final aggregation / output writing — no more agent spawns.
#
# Required env:
#   CROSS_CLARIFY_STUB_STATE   directory the runner can read+write counter files in.
# Optional env:
#   CROSS_CLARIFY_PROMPT_LOG   absolute file path; if set, stub appends the
#                              decoded prompt body (positional arg to `run`)
#                              before each emit so the spec can assert that
#                              round 3 contains "## External Feedback".

set -eu

case "${1-}" in
  --version|-v|version)
    echo "stub-opencode 1.14.99"
    exit 0
    ;;
  run)
    : # fallthrough
    ;;
  *)
    echo "stub-opencode-cross-clarify: unsupported mode: ${*:-<no args>}" >&2
    exit 2
    ;;
esac

state_dir="${CROSS_CLARIFY_STUB_STATE:-/tmp/aw-e2e-cross-clarify-state}"
mkdir -p "$state_dir"

# Capture prompt (first positional after 'run') before flag-parsing eats it.
shift
RAW_PROMPT="${1-}"
agent="default"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      shift
      agent="${1-default}"
      ;;
  esac
  shift || true
done
agent_key=$(printf '%s' "$agent" | tr -c 'A-Za-z0-9._-' '_')
counter_file="$state_dir/$agent_key.count"

# Bump counter atomically.
count=1
if [ -f "$counter_file" ]; then
  count=$(($(cat "$counter_file") + 1))
fi
printf '%s' "$count" > "$counter_file"

# Append the prompt body to the prompt log (if configured).
if [ -n "${CROSS_CLARIFY_PROMPT_LOG:-}" ]; then
  {
    printf '=== %s round %s ===\n' "$agent" "$count"
    printf '%s\n' "$RAW_PROMPT"
    printf '=== END %s round %s ===\n' "$agent" "$count"
  } >> "$CROSS_CLARIFY_PROMPT_LOG"
fi

# Decide what to emit based on (agent, count).
# RFC-100: the questioner has a clarify channel ⇒ mandatory ask-back. A
# 'continue' answer makes it ask AGAIN (it may not finalize until 'stop'), so the
# questioner emits a cross-clarify question on BOTH its first (count 1) and its
# cascade-rerun (count 2) invocations; only after the user answers with 'stop'
# does its third invocation (count 3) emit <workflow-output>.
if [ "$agent" = "questioner" ] && [ "$count" -le 2 ]; then
  # questioner.first (count 1) + questioner.cascade (count 2): emit a cross-clarify question.
  body='{"questions":[{"id":"q-redis","title":"Should we use Redis for caching?","kind":"single","recommended":true,"options":["Yes","No","Maybe"]}]}'
  printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"<workflow-clarify>$body</workflow-clarify>\"}}"
  exit 0
fi

# All other rounds: emit <workflow-output>. Designer outputs "design"; questioner
# outputs "main"; payload text encodes the round so the spec can verify ordering.
case "$agent" in
  designer)
    port="design"
    text="design v$count"
    ;;
  questioner)
    port="main"
    text="questioner v$count: all good"
    ;;
  *)
    port="design"
    text="other v$count"
    ;;
esac
printf '%s\n' "{\"type\":\"text\",\"timestamp\":0,\"part\":{\"type\":\"text\",\"text\":\"<workflow-output>\\n  <port name=\\\"$port\\\">$text</port>\\n</workflow-output>\"}}"
exit 0
