#!/usr/bin/env bash
# Run one Rally agent forever: a fresh Claude Code session per piece of work, Ralph style.
#
#   scripts/agent-loop.sh /path/to/checkout [agent-name]
#
# The checkout must be a clone of the project's repository whose `origin` the agent can push to,
# with the Rally MCP server configured for Claude Code under the name "rally" using an agent token:
#
#   claude mcp add --transport http rally https://<your-worker>/mcp \
#     --header "Authorization: Bearer $RALLY_AGENT_TOKEN"
#
# Give each concurrently running agent its own checkout. When there is no work, sleep and ask again.

set -euo pipefail

checkout="${1:?usage: agent-loop.sh <checkout> [agent-name]}"
name="${2:-$(hostname -s)-$$}"
idle_sleep="${RALLY_IDLE_SLEEP:-300}"
prompt_file="$(cd "$(dirname "$0")/.." && pwd)/docs/agent-prompt.md"

cd "$checkout"
while true; do
	log="$(mktemp "${TMPDIR:-/tmp}/rally-agent.XXXXXX")"
	prompt="$(sed "s/{{AGENT_NAME}}/$name/g" "$prompt_file")"
	claude -p "$prompt" --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,mcp__rally" 2>&1 | tee "$log" || true

	if grep -q "RALLY_NO_WORK" "$log"; then
		echo "[$name] no work available, sleeping ${idle_sleep}s"
		sleep "$idle_sleep"
	fi
	rm -f "$log"
done
