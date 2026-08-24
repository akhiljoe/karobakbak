# The backup job.
#
# `pg_dump` must match the server's major version, so this is built from the
# same PostgreSQL image the database runs — a 16 client against a 17 server is
# a refusal, and finding that out during a restore is finding it out too late.
#
# Everything else is three small additions: gpg to encrypt the dump (§8.1),
# curl to report the result inward, and rclone to put the dump somewhere that is
# not this machine.
#
# rclone rather than a vendor CLI, deliberately. A backup that lives beside the
# database it protects is not a backup -- one host failure loses both -- and the
# destination is a hosting decision that is not this image's business. rclone
# speaks S3, B2, SFTP, Google Drive and thirty other things through one config,
# so the choice can be made later without rebuilding anything.
FROM postgres:16-alpine

RUN apk add --no-cache gnupg curl rclone

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Two directories that have to exist, owned by the user that will use them,
# *before* the volume is mounted — both were found by running this rather than
# by reading it.
#
# gpg insists on a private home it can write to, and refuses with a bare
# "Permission denied" when it cannot. Running as a non-root user means `$HOME`
# is not necessarily writable, so it gets an explicit one.
#
# `/backups` exists in the image so that Docker seeds a fresh named volume with
# this ownership. A volume mounted onto a path that does not exist in the image
# is created owned by root, and the container then cannot write its own backups.
RUN mkdir -p /var/lib/backup/gnupg /var/lib/backup/rclone /backups  && chown -R postgres:postgres /var/lib/backup /backups  && chmod 700 /var/lib/backup/gnupg

ENV GNUPGHOME=/var/lib/backup/gnupg
# Same reasoning as GNUPGHOME: a non-root user has no writable $HOME to put a
# config in, and rclone fails obscurely rather than clearly when it cannot.
ENV RCLONE_CONFIG=/var/lib/backup/rclone/rclone.conf

# Never as root: this container needs to read a passphrase and write a volume,
# and nothing else. `postgres` already exists in this image.
USER postgres

ENTRYPOINT ["/usr/local/bin/backup.sh"]
