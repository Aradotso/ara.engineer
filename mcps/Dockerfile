FROM oven/bun:1

WORKDIR /app

# Install curl + jq + Infisical CLI.
# Infisical CLI loads secrets from /mcp (Ara-passwords project) at boot
# using the mcp-service universal-auth identity.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bash jq \
 && curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
 && apt-get update && apt-get install -y --no-install-recommends infisical \
 && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY src/ ./src/

EXPOSE 3000

# Start: exchange the universal-auth client-id/secret for a JWT, then wrap
# the bun process with `infisical run --path=/mcp`, which injects every
# key under /mcp/* as env vars. If the bootstrap secrets aren't set,
# fall back to plain bun — so local dev without Infisical still works.
CMD ["/bin/bash", "-euc", " \
  if [ -n \"${INFISICAL_CLIENT_ID:-}\" ] && [ -n \"${INFISICAL_CLIENT_SECRET:-}\" ]; then \
    export INFISICAL_TOKEN=$(curl -sS -X POST https://app.infisical.com/api/v1/auth/universal-auth/login \
      -H 'Content-Type: application/json' \
      -d \"{\\\"clientId\\\":\\\"${INFISICAL_CLIENT_ID}\\\",\\\"clientSecret\\\":\\\"${INFISICAL_CLIENT_SECRET}\\\"}\" \
      | jq -r .accessToken); \
    if [ -z \"$INFISICAL_TOKEN\" ] || [ \"$INFISICAL_TOKEN\" = 'null' ]; then \
      echo '[mcp] Infisical login failed — starting without secrets'; \
      exec bun run src/index.ts; \
    fi; \
    echo '[mcp] Infisical auth ok, running with /mcp secrets injected'; \
    exec infisical run \
      --projectId=6d518288-7854-49d2-aa42-8ffd285dafa1 \
      --env=\"${INFISICAL_ENV:-dev}\" --path=/mcp --recursive --token \"$INFISICAL_TOKEN\" \
      -- bun run src/index.ts; \
  else \
    echo '[mcp] INFISICAL_CLIENT_ID not set — starting without Infisical wrapper'; \
    exec bun run src/index.ts; \
  fi"]
