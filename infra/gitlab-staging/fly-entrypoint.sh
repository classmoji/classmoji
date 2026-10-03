#!/bin/bash
# Fly gives a machine one volume, but Gitlab keeps state in three folders.
# Point all three at the volume mounted on /data before Gitlab starts.
#
# /etc/gitlab matters most: it holds gitlab-secrets.json, the key Gitlab
# encrypts runner tokens and other settings with. Lose it on a restart and
# those silently stop working.
set -e

for pair in config:/etc/gitlab logs:/var/log/gitlab data:/var/opt/gitlab; do
  name=${pair%%:*}
  path=${pair#*:}
  mkdir -p "/data/$name"
  if [ ! -L "$path" ]; then
    rm -rf "$path"
    ln -s "/data/$name" "$path"
  fi
done

# The image's own start command (its CMD; older images called it
# /assets/wrapper). Check with:
#   docker image inspect gitlab/gitlab-ce:latest --format '{{json .Config.Cmd}}'
exec /assets/init-container
