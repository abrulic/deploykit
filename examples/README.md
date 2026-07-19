# Example output

These are the **actual files deploykit generates** — byte-for-byte, straight from the generators — for one representative monorepo. Nothing here is hand-written; it's what lands in your repo (as a reviewable PR) after `deploykit init`.

Everything is produced from a single source of truth, [`deploykit.config.ts`](deploykit.config.ts), by `deploykit generate`.

## The example monorepo

A **Turbo** monorepo (`pnpm`, Node 20) with the Fly app-name prefix `acme`, a primary region of `iad` plus a stateless extra region `lhr`, and Cloudflare wiring for `example.com`. Two deployable apps:

| App | Type | Highlights |
|-----|------|-----------|
| **`web`** — `apps/web` | React Router SSR (server) | Depends on `@acme/ui` + `@acme/database`; a Prisma target (client generated at build, commented migration hook in `fly.toml`); runtime secrets `DATABASE_URL` / `SESSION_SECRET`; build-time `VITE_API_URL`; preview + staging + production, with the custom domain `shop.example.com` on production. |
| **`marketing`** — `apps/marketing` | Astro (static) | Depends on `@acme/ui`; served with `serve`; preview + staging only. |

## Files

| Path | What it is |
|------|-----------|
| [`deploykit.config.ts`](deploykit.config.ts) | The source of truth. Edit it, then run `deploykit generate` to re-emit everything below. |
| [`.dockerignore`](.dockerignore) | Repo-root ignore — keeps `node_modules`, build output, and (critically) `.env*` / `.deploykit/` secrets out of the Docker build context. |
| [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) | The whole pipeline: a `changes` filter, then `preview` + `teardown`, `staging`, and a gated `production` job. |
| [`apps/web/Dockerfile`](apps/web/Dockerfile) | Multi-stage `turbo prune` build; runs `prisma generate`; server runner with a package-manager-free `CMD`. |
| [`apps/web/fly.toml`](apps/web/fly.toml) | Health check + the **commented-out** Prisma migration hook. |
| [`apps/marketing/Dockerfile`](apps/marketing/Dockerfile) | Static build served with `serve`. |
| [`apps/marketing/fly.toml`](apps/marketing/fly.toml) | Health check (no migration hook — no Prisma). |

## Regenerate them yourself

From the repo root:

```bash
# Point deploykit at this directory (which already has the config) and re-emit:
pnpm dev -- generate --cwd examples --force
```

See the main [README](../README.md) for what each piece does and how to configure it.
