#!/usr/bin/env bash
# Run one Rally agent forever: a fresh coding-agent session per piece of work, Ralph style.
#
#   scripts/agent-loop.sh /path/to/checkout [agent-name]
#
# The checkout must be a clone (or worktree) of the project's repository whose `origin` the agent can
# push to, with the Rally MCP server configured under the name "rally" using an agent token.
#
# Claude Code (default):
#
#   claude mcp add --transport http rally https://<your-worker>/mcp \
#     --header "Authorization: Bearer $RALLY_AGENT_TOKEN"
#
# opencode (RALLY_AGENT_CLI=opencode): an opencode.json in the checkout that reads the token from the
# environment, and RALLY_AGENT_TOKEN exported before starting the loop:
#
#   { "mcp": { "servers": { "rally": { "type": "remote", "url": "https://<your-worker>/mcp",
#       "headers": { "Authorization": "Bearer {env:RALLY_AGENT_TOKEN}" } } } } }
#
# Environment:
#   RALLY_AGENT_CLI    claude (default) or opencode
#   RALLY_MODEL        model to use, e.g. opencode/mimo-v2.6-flash-free (default: the CLI's default)
#   RALLY_IDLE_SLEEP   seconds to wait when there is no work (default 300)
#   RALLY_MAX_RUNS     stop after this many sessions (default: run forever)
#
# Give each concurrently running agent its own checkout. When there is no work, sleep and ask again.

set -euo pipefail

checkout="${1:?usage: agent-loop.sh <checkout> [agent-name]}"
name="${2:-$(hostname -s)-$$}"
cli="${RALLY_AGENT_CLI:-claude}"
model="${RALLY_MODEL:-}"
idle_sleep="${RALLY_IDLE_SLEEP:-300}"
max_runs="${RALLY_MAX_RUNS:-0}"
prompt_file="$(cd "$(dirname "$0")/.." && pwd)/docs/agent-prompt.md"

run_session() {
	local prompt="$1"
	case "$cli" in
	claude)
		claude -p "$prompt" ${model:+--model "$model"} \
			--permission-mode acceptEdits --allowedTools "Bash,Edit,Write,mcp__rally"
		;;
	opencode)
		# A private server, so the session sees this environment (token, project variables).
		opencode run --standalone --auto ${model:+--model "$model"} --title "rally: $name" "$prompt"
		;;
	*)
		echo "Unknown RALLY_AGENT_CLI '$cli' (use claude or opencode)" >&2
		exit 2
		;;
	esac
}

cd "$checkout"
runs=0
while true; do
	log="$(mktemp "${TMPDIR:-/tmp}/rally-agent.XXXXXX")"
	prompt="$(sed "s/{{AGENT_NAME}}/$name/g" "$prompt_file")"
	run_session "$prompt" 2>&1 | tee "$log" || true
	runs=$((runs + 1))

	no_work=false
	grep -q "RALLY_NO_WORK" "$log" && no_work=true
	rm -f "$log"

	if [ "$max_runs" -gt 0 ] && [ "$runs" -ge "$max_runs" ]; then
		echo "[$name] finished $runs session(s)"
		break
	fi
	if $no_work; then
		echo "[$name] no work available, sleeping ${idle_sleep}s"
		sleep "$idle_sleep"
	fi
done
