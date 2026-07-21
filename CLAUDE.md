# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@alminabrulic/deploykit` — a local-only TypeScript CLI (ESM, Node ≥ 20) that reads a Turbo or Nx monorepo and emits the CI/CD files to deploy it to Fly.io: Dockerfiles, `fly.toml`, a GitHub Actions workflow, `.dockerignore`, `DEPLOYMENTS.md`, and `deploykit.config.ts`. There is no backend, no runtime, and no telemetry — the output is files the user owns.

The package ships **two** tsup ESM builds ([tsup.config.ts](tsup.config.ts) exports an array):

- `src/index.ts` → `dist/index.js` — the CLI (`bin`, shebang banner, owns `clean`).
- `src/config.ts` → `dist/config.js` + `.d.ts` — the library entry behind `package.json` `exports`, because every generated `deploykit.config.ts` opens with `import { defineConfig } from "@alminabrulic/deploykit"`. Without it that import resolves to nothing and the user's config fails to typecheck — which is the entire reason the config is TypeScript instead of JSON.

So [src/config.ts](src/config.ts) is **published public API**: anything exported there ships with types, and any import added to it lands in consumers' dependency graph. Keep it types + `defineConfig` + pure constants. After touching either build or the `exports` map, verify like a consumer, not just with `pnpm build`: `npm pack`, install the tarball in a temp project, then `node -e "import('@alminabrulic/deploykit')"` and `tsc` over a generated config.

## Commands

```bash
pnpm install                    # also installs git hooks via lefthook (prepare script)
pnpm dev init --dry-run         # run the CLI from source (tsx), against cwd
pnpm dev init --cwd /path/to/some/monorepo --dry-run
pnpm build                      # tsup → dist/
pnpm test                       # vitest run
pnpm test:watch
pnpm typecheck                  # tsc --noEmit
pnpm lint / pnpm lint:fix       # biome check [--write]
pnpm knip                       # unused exports/deps
```

Note: do **not** write `pnpm dev -- init …` (as README's Development section does) — pnpm forwards the `--` and the CLI rejects it as an unknown option.

Single test file / single test:

```bash
pnpm vitest run src/generate/workflow.test.ts
pnpm vitest run src/generate/workflow.test.ts -t "never expands a secret"
```

A pre-commit hook (lefthook) runs `biome check --write` on staged files and then the full test suite; both must pass to commit.

## Architecture

### The pipeline

`deploykit init` is a five-phase pipeline orchestrated by [src/commands/init.ts](src/commands/init.ts). Nothing is written or provisioned until the user confirms the plan:

1. **Preflight** ([src/preflight.ts](src/preflight.ts)) — git repo? Turbo/Nx monorepo? are `gh`/`flyctl` present and authenticated?
2. **Detect** ([src/detect.ts](src/detect.ts)) — package manager, workspace packages, per-app framework, `serve` model, port, transitive internal deps, Prisma schemas, referenced env-var names. Pure filesystem reads; returns a `Detection`.
3. **Ask** ([src/prompts.ts](src/prompts.ts)) — `buildConfig()` turns a `Detection` + CLI options into a `DeploykitConfig`, prompting via `@clack/prompts` with detected values pre-filled.
4. **Plan** ([src/plan.ts](src/plan.ts), [src/generate/index.ts](src/generate/index.ts)) — `planFiles()` computes every output file in memory and classifies each against disk as `new` / `identical` / `modified`; `renderPlan()` renders it.
5. **Emit** — `writeFiles()`, then the opt-in side effects: [provision.ts](src/provision.ts) (Fly apps, GitHub secrets/environments), [provision-cloudflare.ts](src/provision-cloudflare.ts) + [cloudflare.ts](src/cloudflare.ts) (DNS/CDN), [deploy.ts](src/deploy.ts) (first staging deploy), [pr.ts](src/pr.ts) (branch + PR).

`deploykit generate` ([src/commands/generate.ts](src/commands/generate.ts)) skips phases 1–3: it loads the committed config and re-emits everything from it. `deploykit rollback` ([src/commands/rollback.ts](src/commands/rollback.ts)) is independent — it lists Fly releases and redeploys a prior image.

### `deploykit.config.ts` is the source of truth

[src/config.ts](src/config.ts) defines the config types (`DeploykitConfig` → `apps: Record<string, AppConfig>` → `environments: Partial<Record<EnvironmentKind, AppEnvironment>>`) and is the contract for every generator. Detection exists only to *produce* a config; generators consume *only* a config, never a `Detection`.

The config is emitted as TypeScript (for editor types) whose payload is a plain **object literal**. [src/config-file.ts](src/config-file.ts) locates the `defineConfig(...)` call and hands the rest to [src/config-literal.ts](src/config-literal.ts), a small recursive-descent reader that parses the JS object-literal subset as *data* — the config is never executed. Any generator change that puts an expression, spread, or template placeholder into the emitted config breaks `deploykit generate`.

The reader is deliberately lenient about **form** and strict about **content**: quoted or bare keys, either quote style, comments and trailing commas all parse, because the file lands in a repo whose formatter will rewrite it (that exact drift broke `examples/deploykit.config.ts` once). Anything needing evaluation is rejected with the line number. Keep both halves of that when touching it — accepting an identifier or call would mean evaluating user input.

### Generators

Everything under [src/generate/](src/generate/) is a pure function `config → string`, with no IO except in `index.ts`:

- [dockerfile.ts](src/generate/dockerfile.ts) dispatches to [dockerfile-turbo.ts](src/generate/dockerfile-turbo.ts) (`turbo prune` multi-stage) or [dockerfile-nx.ts](src/generate/dockerfile-nx.ts) (`nx build` + `dist/<root>`); [dockerfile-shared.ts](src/generate/dockerfile-shared.ts) holds the `PM` package-manager command table, the `serveModel()` fallback, and the install/CMD logic.
- [workflow.ts](src/generate/workflow.ts) builds `.github/workflows/deploy.yml` (changes filter → preview / teardown / staging / production jobs).
- [flytoml.ts](src/generate/flytoml.ts), [dockerignore.ts](src/generate/dockerignore.ts), [summary.ts](src/generate/summary.ts) (`DEPLOYMENTS.md`), [configfile.ts](src/generate/configfile.ts).

Two invariants worth knowing:

- **The runner branches on `AppConfig.serve` (`"server"` | `"static"`), not on `framework`.** `framework` is a detection hint that drives default ports, the Next special case, and plan labels. Adding framework support usually means teaching detection to set the right `serve`/`startCommand`/`outputDir`, not adding a branch in the Dockerfile generator.
- **Optional config fields must degrade to byte-identical output.** Configs written by older versions omit fields (`serve`, `namePrefix`, `regions`, `nxIntegrated`); each has an explicit fallback so an existing repo regenerates unchanged. New optional fields must follow this.

### Injection safety is a load-bearing property

Generated shell and YAML embed repo-derived values (app names, paths, scripts read from `package.json`) and user secret **names**. Secret *values* are never interpolated into script text — the workflow exposes them as `SECRET_<name>` env vars and the script only ever references them as shell variables, so a value containing quotes or `$` can't break or inject into the deploy step ([workflow.ts](src/generate/workflow.ts)). `src/util/exec.ts` always spawns with `shell: false`. Keep both properties when editing generation or exec code; `workflow.test.ts` asserts the first.

### Testing conventions

Tests are colocated (`foo.ts` + `foo.test.ts`) and run with Vitest, no mocking framework. Two patterns:

- **Generators** — assert on the produced string. Shared fixtures (`sampleConfig`, `sampleWebApp`, `sampleApiApp`, `writeTree()` for a real temp-dir monorepo) live in [src/testing/fixtures.ts](src/testing/fixtures.ts).
- **IO orchestration** — modules that shell out expose an injected deps seam with real defaults: `PrDeps`, `DeployDeps`, `AuthDeps`, and the `deps?: Partial<…>` parameter. Tests pass fakes; nothing hits the network or `gh`/`flyctl`. Follow this pattern for new modules that shell out rather than mocking `node:child_process`.

Any change to generation logic needs a test covering the output.

### Examples are real output

[examples/](examples/) is the byte-for-byte output for a two-app Turbo monorepo, all generated from [examples/deploykit.config.ts](examples/deploykit.config.ts), and [examples.test.ts](src/generate/examples.test.ts) fails the build if it stops matching. So any intentional generator change means refreshing the fixtures in the same commit:

```bash
pnpm dev generate --cwd examples --yes
```

Keep the config file exactly what `generateConfigFile()` emits — `JSON.stringify` formatting, key order matching `assemble()` / `appConfigFor()` in [prompts.ts](src/prompts.ts) — rather than hand-editing it, since the claim it makes is that these are untouched generator output. [biome.json](biome.json) excludes it from formatting for that reason (Biome would unquote the keys); the loader parses it either way, so this is about fidelity, not breakage.

## Code style

[.claude/skills/SKILL.md](.claude/skills/SKILL.md) (`code-quality-standards`) is the authority and applies to all code here; [REVIEW.md](REVIEW.md) restates the subset enforced in review. The rules that bite most often in this codebase:

- No barrel exports (`export * from`), no type assertions (`as any`, `as T`, `as unknown as`) — narrow with type predicates instead (see `isDeploykitConfig`).
- Single object parameter for functions taking required input; no explicit return type annotations (rely on inference).
- Comments explain non-obvious *why* only — a hidden constraint, a workaround, an invariant. This codebase's existing comments are deliberately dense on Fly/pnpm/Prisma quirks; match that bar, don't add restating comments.
- Biome handles formatting (2-space, double quotes, 80 cols, semicolons, organized imports) — don't hand-format, and don't nit style Biome would fix.
- ESM: relative imports must carry the `.js` extension.

Public-API or generated-artifact changes should be reflected in [README.md](README.md).

## Notes

- `docs/` is untracked build output of a separate docs site — not part of this package; ignore it.
- License is BUSL-1.1 (source-available), and releases publish to npm with provenance via [.github/workflows/release.yml](.github/workflows/release.yml).
