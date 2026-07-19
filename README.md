# deploykit

Automate CI/CD for **Turbo and Nx monorepos** deploying to **Fly.io**.

Run one command in your monorepo and get a reviewable PR that wires up:

- **PR preview environments** — every pull request gets its own deployed app, with the URL commented on the PR, torn down automatically when the PR closes.
- **Staging** — deploys on merge to `main`.
- **Production** — deploys behind a manual approval gate (GitHub Environment protection).

deploykit reads your workspace graph, figures out which apps are deployable, and generates the Dockerfiles, `fly.toml` files and a GitHub Actions workflow — all landed as files you own and can edit.

## Quick start

```bash
npx deploykit init
```

This runs five phases:

1. **Preflight** — verifies you're in a git repo with a Turbo or Nx monorepo and that `gh` / `flyctl` are available.
2. **Detect** — reads your package manager, workspace packages, per-app framework, ports, internal dependencies and env-var names.
3. **Ask** — a handful of questions, each pre-filled from detection (which apps, which environments, Fly org/region).
4. **Plan** — shows exactly what will be written and provisioned; nothing happens until you confirm.
5. **Emit** — writes the files (and, if you opt in, provisions Fly apps / GitHub secrets and opens a PR).

### Non-interactive

```bash
deploykit init --yes --org my-org --region iad
deploykit init --yes --org my-org --region iad --dry-run   # print the plan only
```

Flags:

| Flag | Description |
|------|-------------|
| `--yes`, `-y` | Accept detected defaults, no prompts. |
| `--org <slug>` | Fly organization slug. |
| `--region <list>` | Fly region(s), comma-separated. The first is the primary; any others are extra **stateless** regions the app is scaled into after each deploy (e.g. `iad,lhr,fra`). |
| `--dry-run` | Detect and print the plan, but write nothing. |
| `--provision` | Create Fly apps and set the `FLY_API_TOKEN` GitHub secret (each step confirmed). |
| `--pr` | Commit the generated files on a branch and open a PR. |
| `--cwd <dir>` | Run against a different directory. |

## What it generates

```
apps/<app>/Dockerfile          multi-stage, turbo-prune based
apps/<app>/.dockerignore
apps/<app>/fly.toml
.github/workflows/deploy.yml    changes → preview / teardown / staging / production
deploykit.config.ts             source of truth for every decision
```

Each `fly.toml` includes an HTTP health check (`/` by default; set
`healthCheckPath` per app in `deploykit.config.ts` for an API that 404s at `/`).
Fly waits for it before shifting traffic to a new release and keeps the old
machines running if it fails — so a bad deploy rolls itself back.

## Rolling back

When a release deployed cleanly but turned out bad, redeploy a previous image:

```bash
deploykit rollback --app web --env production
```

It lists the environment's Fly releases, lets you pick one, shows the exact
`flyctl deploy --image …` it will run, and asks before doing it. Use
`--to <version> --yes` to script it. This rolls back the **app image only** — it
does **not** undo database migrations, so an older image may not run against a
schema a newer release migrated.

## Multiple regions

Pass more than one region and the extras become **stateless** regions the app is
scaled into after each staging/production deploy (previews stay single-region):

```bash
deploykit init --region iad,lhr,fra      # primary iad, plus lhr and fra
```

You can also set `regions` under `provider` in `deploykit.config.ts`. Each extra
region gets one machine via `flyctl scale count 1 --region <r>` after the deploy.
This is for **stateless** apps: deploykit does not model database locality, so a
far-region machine still talks to whatever single-region `DATABASE_URL` you set —
expect high write latency. Read replicas / `fly-replay` are out of scope.

## Database migrations

deploykit does **not** run migrations — a bad one causes irreversible data loss,
and owning that is out of scope. Instead, when it detects a Prisma schema in an
app it writes a **commented-out** hook into that app's `fly.toml`:

```toml
# [deploy]
#   release_command = "(cd packages/db && npx prisma migrate deploy --schema ./prisma/schema.prisma)"
```

`[deploy].release_command` is Fly's idiomatic migration hook: it runs once per
release, before new machines take traffic. Uncomment it only against a database
you own, and make sure the Prisma CLI and schema are present in your runtime
image. Note that `deploykit rollback` reverts the **image only** — it does not
undo a migration this hook applied, so prefer additive (expand/contract)
migrations. Using another tool (Drizzle, Knex, …)? Uncomment and swap the
command for its migrate step.

## Scope (v1)

- **Turbo** monorepos — full support (`turbo prune` multi-stage builds).
- **Nx** monorepos — supported via `nx build` + `dist/<projectRoot>` output. Node-server and static (Vite/Astro) apps are solid; Next/SSR Dockerfiles follow Nx conventions but are worth a glance before your first deploy.
- **Fly.io** as the deploy target.
- **No database provisioning** — deploykit provisions no database. It detects Prisma and writes a commented, opt-in migration hook (see [Database migrations](#database-migrations)); the database itself is yours to create and own.

## Security & Privacy

deploykit is a **local CLI with no backend** — it never sends your credentials
anywhere except directly to GitHub, Fly, and Cloudflare to do the work you ask
for, and it collects **no telemetry**.

- **GitHub** sign-in uses the OAuth device flow ("Authorize DeployKit"); the
  token is stored by the official `gh` CLI (your OS keychain or
  `~/.config/gh/hosts.yml`) — deploykit keeps no copy.
- **Fly** is handled by `flyctl`; the CI deploy token is written only as your
  repo's `FLY_API_TOKEN` GitHub Actions secret.
- **Cloudflare** tokens (optional) stay in the git-ignored `.deploykit/credentials`
  file (mode `0600`) or an env var — never committed.

You can verify all of this: the code is source-available (see
[`src/auth.ts`](src/auth.ts)), and releases ship with npm provenance. Full
details and revocation steps are in [SECURITY.md](SECURITY.md).

## License

deploykit is **source-available** under the [Business Source License 1.1](LICENSE) (`BUSL-1.1`).

- ✅ Free to read, modify, self-host, and use for **non-production** and **non-commercial production** purposes.
- 💳 Using deploykit in production **for a commercial purpose** (building, deploying, or operating software that is sold or offered as a paid service) requires a **commercial license** — get in touch.
- 🔓 Each released version automatically converts to the **Apache License 2.0** four years after its release (its Change Date).

See [LICENSE](LICENSE) for the full terms.
