#!/bin/sh
# Raise nginx's per-worker connection ceiling from the environment.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------------------------------------------------------------------
# `worker_connections` lives in the `events` block of the *main* nginx.conf,
# and the main config has no `include` for that context — only `http` does,
# which is where `conf.d/default.conf` lands. So the one number that limits how
# many chat sockets this edge can hold is the one number the site config cannot
# set.
#
# The stock value is 1024, and a proxied WebSocket costs **two** of them: one
# downstream to the browser, one upstream to the backend. That puts a hard
# ceiling of roughly `worker_processes x 512` concurrent conversations at the
# edge, reached long before any backend limit — and it fails as timeouts and
# refused upgrades, which look like a backend problem.
#
# The nginx image runs every executable in /docker-entrypoint.d before starting,
# so rewriting the value there keeps the setting in the environment, where the
# rest of this stack keeps its tunables, instead of forking the whole main
# config to change one integer.
set -eu

connections="${NGINX_WORKER_CONNECTIONS:-1024}"
files="${NGINX_WORKER_RLIMIT_NOFILE:-}"

# A ceiling on file descriptors below the connection ceiling is worse than
# useless: nginx accepts up to `worker_connections` and then fails on accept()
# with EMFILE, which reads as an unexplained refusal rather than a limit. So it
# defaults to twice the connection count, which is what a proxied socket costs.
if [ -z "$files" ]; then
  files=$((connections * 2))
fi

sed -i "s/^\([[:space:]]*\)worker_connections[[:space:]].*/\1worker_connections ${connections};/" \
  /etc/nginx/nginx.conf

if grep -q '^worker_rlimit_nofile' /etc/nginx/nginx.conf; then
  sed -i "s/^worker_rlimit_nofile[[:space:]].*/worker_rlimit_nofile ${files};/" /etc/nginx/nginx.conf
else
  sed -i "1i worker_rlimit_nofile ${files};" /etc/nginx/nginx.conf
fi

echo "nginx: worker_connections ${connections}, worker_rlimit_nofile ${files}"
