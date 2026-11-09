FROM node:22.16.0-bookworm-slim
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv fuse3 libfuse3-3 ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.166.0 && test "$(codex --version)" = "codex-cli 0.166.0"
RUN id user && passwd -l root && passwd -l user && if test -f /usr/bin/sudo; then chmod 700 /usr/bin/sudo; fi && if test -f /usr/bin/su; then chmod 700 /usr/bin/su; fi
COPY runtime/runner /opt/designx/runner
RUN python3 -m venv /opt/designx/venv && /opt/designx/venv/bin/pip install --no-cache-dir /opt/designx/runner
COPY runtime/matfs/dist/designx-matfs /opt/designx/bin/designx-matfs
COPY runtime/matfs/dist/provenance.json /opt/designx/matfs-provenance.json
COPY runtime/provenance.json /opt/designx/source-provenance.json
COPY infra/e2b/dist/validate.mjs /opt/designx/validate.mjs
COPY packages/ai-runtime/src/deepseek-models.json /opt/designx/models.json
RUN chmod 755 /opt/designx/bin/designx-matfs && mkdir -p /var/lib/designx/runs /workspaces/designx/runs /workspaces/designx/sessions /workspaces/designx/materials && chmod 700 /var/lib/designx /var/lib/designx/runs && chmod 755 /workspaces /workspaces/designx /workspaces/designx/runs /workspaces/designx/sessions /workspaces/designx/materials && echo user_allow_other >> /etc/fuse.conf
USER user
WORKDIR /workspaces/designx
