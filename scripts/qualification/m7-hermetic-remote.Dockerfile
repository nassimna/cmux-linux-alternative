FROM node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        openssh-client \
        openssh-server \
        tmux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd

COPY scripts/qualification/m7-hermetic-remote.mjs /opt/cmux-qualification/m7-hermetic-remote.mjs

ENTRYPOINT ["node", "/opt/cmux-qualification/m7-hermetic-remote.mjs", "/usr/bin/tmux", "--persistent"]
