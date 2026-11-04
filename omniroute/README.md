# OmniRoute — Local Gateway Setup

This is the external service setup for **OmniRoute** (open-source LLM gateway, MIT, `github.com/diegosouzapw/OmniRoute`). It does not modify the Habblaud codebase (`client/`, `server/`, `shared/`).

## Quickstart

```bash
# 1. Configure encryption key
cp omniroute/.env.example omniroute/.env  # or generate: openssl rand -hex 32
# Edit omniroute/.env: STORAGE_ENCRYPTION_KEY=<64-char-hex>

# 2. Start
cd omniroute
docker compose up -d --build

# 3. Verify
curl -s -o /dev/null -w "%{http_code}" http://localhost:20128/v1/models
# Expected: 200 once a provider is connected; otherwise 404/503 while no eligible route exists.
```

## Endpoint

- Gateway: `http://localhost:20128`
- OpenAI-compatible path: `/v1/chat/completions`
- Must pass an OmniRoute key (created via dashboard after first run) and a `model` value (e.g., `auto`).

## Important warnings

- `docker compose down -v` **destroys all persistent data** (routing config, encrypted provider credentials, gateway keys). Do not run unless you intend to reset.
- The `.env` file is gitignored (`omniroute/.env`) and must never be committed.
- Image version is pinned indirectly via `diegosouzapw/omniroute:latest`; for deterministic builds, pin to a specific tag in `docker-compose.yml`.

## Upgrade

```bash
docker compose pull
# Or update image tag in docker-compose.yml, then:
docker compose up -d --build
```

## References

- Upstream repo: `https://github.com/diegosouzapw/OmniRoute`
- Docker Hub: `diegosouzapw/omniroute`
- Docs (upstream): `docs/getting-started/` in upstream repo; `README.md` for quickstart.
