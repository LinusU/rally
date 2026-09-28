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
#   RALLY_NUDGE_BACKOFF  seconds to wait before the first resume, doubled each time (default 30)
#   RALLY_RUN_FOR      stop after this long, e.g. 9h, 90m or 3600s
#   RALLY_STOP_AT      stop at this local time: HH:MM (the next one) or "YYYY-MM-DD HH:MM"
#
# After the stop time the loop starts no new session and resumes no stalled one: the session that is
# running then finishes its piece of work, and the loop exits.
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
nudge_backoff="${RALLY_NUDGE_BACKOFF:-30}"
prompt_file="$(cd "$(dirname "$0")/.." && pwd)/docs/agent-prompt.md"

# Seconds since the epoch for a local "YYYY-MM-DD HH:MM", with GNU or BSD date.
epoch_of() {
	date -d "$1" +%s 2>/dev/null || date -j -f "%Y-%m-%d %H:%M:%S" "$1:00" +%s 2>/dev/null
}

deadline=0
if [ -n "${RALLY_RUN_FOR:-}" ]; then
	case "$RALLY_RUN_FOR" in
	*h) seconds=$((${RALLY_RUN_FOR%h} * 3600)) ;;
	*m) seconds=$((${RALLY_RUN_FOR%m} * 60)) ;;
	*s) seconds=${RALLY_RUN_FOR%s} ;;
	*) seconds=$RALLY_RUN_FOR ;;
	esac
	deadline=$(($(date +%s) + seconds))
elif [ -n "${RALLY_STOP_AT:-}" ]; then
	case "$RALLY_STOP_AT" in
	[0-9]:[0-9][0-9] | [0-9][0-9]:[0-9][0-9]) stop_at="$(date +%Y-%m-%d) $RALLY_STOP_AT" ;;
	*) stop_at="$RALLY_STOP_AT" ;;
	esac
	deadline="$(epoch_of "$stop_at")" || {
		echo "RALLY_STOP_AT must be HH:MM or \"YYYY-MM-DD HH:MM\", got '$RALLY_STOP_AT'" >&2
		exit 2
	}
	# A bare HH:MM that has already passed today means tomorrow.
	if [ "$stop_at" != "$RALLY_STOP_AT" ] && [ "$deadline" -le "$(date +%s)" ]; then
		deadline=$((deadline + 86400))
	fi
fi

past_deadline() {
	[ "$deadline" -gt 0 ] && [ "$(date +%s)" -ge "$deadline" ]
}

# Sleep, but never past the stop time.
nap() {
	local seconds="$1"
	if [ "$deadline" -gt 0 ]; then
		local left=$((deadline - $(date +%s)))
		[ "$left" -lt "$seconds" ] && seconds=$((left > 0 ? left : 0))
	fi
	sleep "$seconds"
}

stop_if_past_deadline() {
	if past_deadline; then
		echo "[$name] stop time reached; exiting"
		exit 0
	fi
}

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

if [ "$deadline" -gt 0 ]; then
	echo "[$name] running until $(date -r "$deadline" 2>/dev/null || date -d "@$deadline")"
fi

cd "$checkout"
runs=0
while true; do
	stop_if_past_deadline
	log="$(mktemp "${TMPDIR:-/tmp}/rally-agent.XXXXXX")"
	prompt="$(sed "s/{{AGENT_NAME}}/$name/g" "$prompt_file")"
	id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
	title="rally: $name $id"

	run_session "$id" "$title" "$prompt" 2>&1 | tee "$log" || true
	nudges=0
	backoff="$nudge_backoff"
	while ! grep -Eq "RALLY_(DONE|NO_WORK)" "$log" && [ "$nudges" -lt "$max_nudges" ] && ! past_deadline; do
		nudges=$((nudges + 1))
		# Often a rate limit: resuming right away just fails again, so wait longer each time.
		echo "[$name] session stopped without handing over; resuming it in ${backoff}s ($nudges/$max_nudges)"
		nap "$backoff"
		backoff=$((backoff * 2))
		stop_if_past_deadline
		run_session "$id" "$title" "$nudge" resume 2>&1 | tee -a "$log" || true
	done
	runs=$((runs + 1))

	no_work=false
	gave_up=false
	grep -q "RALLY_NO_WORK" "$log" && no_work=true
	grep -Eq "RALLY_(DONE|NO_WORK)" "$log" || gave_up=true
	rm -f "$log"

	stop_if_past_deadline
	if [ "$max_runs" -gt 0 ] && [ "$runs" -ge "$max_runs" ]; then
		echo "[$name] finished $runs session(s)"
		break
	fi
	if $no_work; then
		echo "[$name] no work available, sleeping ${idle_sleep}s"
		nap "$idle_sleep"
	elif $gave_up; then
		# Rally hands the claim back to the next session under this name, so nothing is lost by waiting.
		echo "[$name] session never handed over; starting a fresh one in ${idle_sleep}s"
		nap "$idle_sleep"
	fi
done
