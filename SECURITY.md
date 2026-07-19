# Security & Privacy

DeployKit is a local command-line tool. **It has no backend, no server, and no
account.** Everything it does runs on your machine and talks directly to
GitHub, Fly, and (optionally) Cloudflare on your behalf. There is nowhere for
your credentials to be sent to us, because there is no "us" to send them to.

This document explains exactly what DeployKit accesses, where every credential
is stored, and how to revoke access — so you can verify these claims rather
than take our word for them.

## No telemetry

DeployKit collects **no analytics, no usage data, and no crash reports.** It
makes no network requests except the ones you can see: direct API calls to
GitHub, Fly, and Cloudflare to do the work you asked for.

## What it accesses, and why

| Provider | How you sign in | Why |
|----------|-----------------|-----|
| **GitHub** | OAuth device flow (the "Authorize DeployKit" screen) | Create/read repos, set Actions secrets, and open the setup PR. Scopes: `repo`, `workflow`. |
| **Fly** | `flyctl` login | Create Fly apps and issue a deploy token for CI. |
| **Cloudflare** *(optional)* | API token you paste | Configure DNS for custom domains, if you use them. |

The GitHub consent screen shows you these scopes before you approve. `repo`
grants read/write to your repositories (including private ones) — that breadth
is required to create repos and manage their Actions secrets and workflows.

## Where your credentials are stored

Every credential lives **on your machine only.** DeployKit never transmits any
of them to a DeployKit-controlled server (there isn't one).

- **GitHub token** — handed straight to the official **GitHub CLI (`gh`)**,
  which stores it in your OS keychain when available, otherwise in
  `~/.config/gh/hosts.yml`. DeployKit does not keep its own copy.
- **Fly token** — managed by **`flyctl`** in its own local config. The CI
  deploy token DeployKit generates is written to your repository as the
  `FLY_API_TOKEN` **GitHub Actions secret** (encrypted at rest by GitHub) so
  your workflow can deploy — it is not stored anywhere else.
- **Cloudflare token** *(optional)* — saved, only if you opt in, to
  `.deploykit/credentials` in your repo, with file permissions `0600` and
  git-ignored by default. You can also pass it via the `CLOUDFLARE_API_TOKEN`
  environment variable and have nothing written to disk.

## How to revoke access

- **GitHub:** Settings → Applications → **Authorized OAuth Apps** → DeployKit →
  **Revoke**. To also clear the local token: `gh auth logout`.
- **Fly:** `flyctl auth logout`, and revoke the `FLY_API_TOKEN` secret from your
  repo's Actions secrets if you no longer want CI to deploy.
- **Cloudflare:** delete the token in the Cloudflare dashboard, and remove the
  `.deploykit/credentials` file.

## How to verify all of this

You don't have to trust this document — you can check it:

- **Read the source.** DeployKit is source-available. The auth flow lives in
  [`src/auth.ts`](src/auth.ts) and credential handling in
  [`src/secrets-file.ts`](src/secrets-file.ts).
- **Watch the network.** Run DeployKit under a proxy or packet inspector; every
  request goes to `github.com`, `api.github.com`, `fly.io`, or
  `api.cloudflare.com` — never to a DeployKit host.
- **npm provenance.** Released packages are published with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  which cryptographically links the package you install to the exact public
  commit and CI run that built it.

## Reporting a vulnerability

Please report security issues privately via
[GitHub's private vulnerability reporting](https://github.com/abrulic/deploykit/security/advisories/new)
rather than opening a public issue. <!-- TODO: add a security contact email if you prefer. -->
We'll acknowledge your report and work with you on a fix and disclosure timeline.
