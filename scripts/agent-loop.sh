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
#       "headers": { "Authorization": "Bearer {env:RALLY_AGENT_TOKEN}" }, "timeout": { "request": 60000 } } } } }
#
# Devin CLI (RALLY_AGENT_CLI=devin):
#
#   devin mcp add rally --scope user --url https://<your-worker>/mcp -H "Authorization: Bearer $RALLY_AGENT_TOKEN"
#
# Environment:
#   RALLY_AGENT_CLI    claude (default), opencode or devin
#   RALLY_MODEL        model to use, e.g. opencode/mimo-v2.6-flash-free (default: the CLI's default)
#   RALLY_IDLE_SLEEP   seconds to wait when there is no work (default 300)
#   RALLY_MAX_RUNS     stop after this many pieces of work (default: run forever)
#   RALLY_MAX_NUDGES   how often to resume a session that stopped before handing its work over (default 5)
#
# Give each concurrently running agent its own checkout. When there is no work, sleep and ask again.

set -euo pipefail

checkout="${1:?usage: agent-loop.sh <checkout> [agent-name]}"
name="${2:-$(hostname -s)-$$}"
cli="${RALLY_AGENT_CLI:-claude}"
model="${RALLY_MODEL:-}"
idle_sleep="${RALLY_IDLE_SLEEP:-300}"
max_runs="${RALLY_MAX_RUNS:-0}"
max_nudges="${RALLY_MAX_NUDGES:-5}"
prompt_file="$(cd "$(dirname "$0")/.." && pwd)/docs/agent-prompt.md"

nudge="Your session stopped before you handed the work over: you have not printed RALLY_DONE. \
Anything you left running in the background was killed. Check where things stand (git status, the pushed \
branch, whether the build and tests pass), then keep following the steps until one of submit_for_review, \
complete_review, save_checkpoint, split_task or block_task has succeeded. Then print RALLY_DONE."

# run_session <session-id> <title> <prompt> [resume]
run_session() {
	local id="$1" title="$2" prompt="$3" resume="${4:-}"
	case "$cli" in
	claude)
		if [ -n "$resume" ]; then
			set -- --resume "$id"
		else
			set -- --session-id "$id"
		fi
		claude -p "$prompt" "$@" ${model:+--model "$model"} \
			--permission-mode acceptEdits --allowedTools "Bash,Edit,Write,mcp__rally"
		;;
	opencode)
		# A private server, so the session sees this environment (token, project variables).
		if [ -n "$resume" ]; then
			set -- --session "$(opencode session list 2>/dev/null | awk -F'\t' -v t="$title" '$2 == t { print $1; exit }')"
		else
			set -- --title "$title"
		fi
		opencode run --standalone --auto "$@" ${model:+--model "$model"} "$prompt"
		;;
	devin)
		# Sessions are listed per directory and each agent has its own checkout, so --continue finds this one.
		if [ -n "$resume" ]; then
			set -- --continue
		else
			set --
		fi
		devin "$@" ${model:+--model "$model"} --permission-mode dangerous \
			--respect-workspace-trust false -p "$prompt"
		;;
	*)
		echo "Unknown RALLY_AGENT_CLI '$cli' (use claude, opencode or devin)" >&2
		exit 2
		;;
	esac
}

cd "$checkout"
runs=0
while true; do
	log="$(mktemp "${TMPDIR:-/tmp}/rally-agent.XXXXXX")"
	prompt="$(sed "s/{{AGENT_NAME}}/$name/g" "$prompt_file")"
	id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
	title="rally: $name $id"

	run_session "$id" "$title" "$prompt" 2>&1 | tee "$log" || true
	nudges=0
	while ! grep -Eq "RALLY_(DONE|NO_WORK)" "$log" && [ "$nudges" -lt "$max_nudges" ]; do
		nudges=$((nudges + 1))
		echo "[$name] session stopped without handing over; resuming it ($nudges/$max_nudges)"
		run_session "$id" "$title" "$nudge" resume 2>&1 | tee -a "$log" || true
	done
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
