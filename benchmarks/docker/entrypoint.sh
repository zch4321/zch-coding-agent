#!/bin/sh
set -eu

command_name="${1:-run}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command_name" in
  run)
    if [ -z "${ZCH_PROVIDER_CREDENTIAL_FILE:-}" ]; then
      echo "ZCH_PROVIDER_CREDENTIAL_FILE is required" >&2
      exit 64
    fi
    ZCH_WORKER_PROVIDER_KEY="$(cat "$ZCH_PROVIDER_CREDENTIAL_FILE")"
    export ZCH_WORKER_PROVIDER_KEY
    export ZCH_PROMPT_DIRECTORY=/opt/zch/resources/prompts
    exec node /opt/zch/zch-agent-headless.mjs run "$@"
    ;;
  proxy)
    exec node /opt/zch/provider-proxy.mjs "$@"
    ;;
  fake-provider)
    exec node /opt/zch/fake-provider.mjs "$@"
    ;;
  grader)
    exec node /opt/zch/grader.mjs "$@"
    ;;
  *)
    echo "Unknown worker command: $command_name" >&2
    exit 64
    ;;
esac
