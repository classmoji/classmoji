# Staging Gitlab on Fly: the official image, plus a start script that keeps
# every folder Gitlab writes on the machine's single volume (see
# fly-entrypoint.sh).
FROM gitlab/gitlab-ce:latest

COPY fly-entrypoint.sh /fly-entrypoint.sh
RUN chmod +x /fly-entrypoint.sh

ENTRYPOINT ["/fly-entrypoint.sh"]
