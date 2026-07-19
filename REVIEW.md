# Review Instructions

Guidance for Claude when reviewing PRs in **deploykit** — a TypeScript CLI that
generates CI/CD (Dockerfiles + GitHub Actions workflows) for Turbo monorepos
deploying to Fly.io. ESM, pnpm, Biome, Vitest, tsup.

## Severity

- **Important** — flag and block:
  - Logic errors and incorrect generated output (bad Dockerfiles / workflow YAML).
  - Security issues: command injection, unsafe shell interpolation, secrets in
    generated files or logs, path traversal when reading/writing the target repo.
  - Broken framework/app detection or start-command inference.
  - Missing/incorrect handling of the monorepo → per-app → per-environment flow.
- **Nit** — mention once, don't block: naming, formatting, minor structure.

## Project code-quality rules (enforce as Important)

These mirror the repo's `code-quality-standards` skill:

- No barrel exports (`export * from`).
- No type assertions (`as any`, `as Type`, `as unknown as`).
- No duplicated functions/components with minor variations — extract the shared part.
- One responsibility per module; no vague names (`helper`, `utils2`, `doStuff`).
- No unnecessary comments — only explain the non-obvious.
- Prefer the simpler equivalent; flag overengineering.

## Always check

- New behavior that generates files has a Vitest test covering the output.
- Generated shell/YAML is safe against injection from repo-derived values
  (app names, paths, scripts read from `package.json`).
- User-facing CLI output (via `@clack/prompts` / `picocolors`) stays consistent
  with the existing tone.
- Public API / generated-artifact changes are reflected in the README.

## Skip

- `dist/**` (build output).
- Lockfile churn (`pnpm-lock.yaml`).
- Biome-enforced formatting — CI/lint already covers it; don't nit on style
  Biome would fix.
