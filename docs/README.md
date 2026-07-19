# deploykit docs

The documentation site for [deploykit](../README.md), built with the
[code-forge docs template](https://github.com/code-forge-io/docs)
(React Router v7 + [content-collections](https://github.com/sdorra/content-collections)).

This is a **self-contained subproject**: it has its own `package.json`,
`node_modules`, and tooling, and is not part of the root deploykit package build.

## Develop

```bash
cd docs
pnpm install
pnpm run dev
```

The dev server serves live content from the `content/` folder with hot reload.

## Content

All documentation lives in [`content/`](./content) as `.md` / `.mdx` files.
The sidebar is generated automatically from the folder structure:

```
content/
├── _index.mdx                 # landing page
├── 01-introduction.mdx
├── 02-getting-started/
│   ├── index.md               # section title
│   ├── 01-installation.mdx
│   ├── 02-quick-start.mdx
│   └── 03-what-it-generates.mdx
├── 03-core-concepts/
├── 04-commands/
├── 05-guides/
└── 06-reference/
```

- Numeric prefixes (`01-`, `02-`) control ordering; they're stripped from the URL.
- Every section folder needs an `index.md` whose `title` becomes the sidebar label.
- Each `.mdx` page needs frontmatter: `title`, `summary`, `description`.

## Build

```bash
pnpm run build      # production build
pnpm run start      # serve the production build
pnpm run typecheck  # tsc
pnpm run test       # vitest
```

## Configuration

- `.env.example` → copy to `.env`. `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_REPO_URL`
  drive the "edit this page" / "report an issue" links and the header GitHub icon.
- Branding lives in `app/routes/index.tsx` (landing page), `app/utils/seo.ts`
  (site name / OG image), and `app/routes/documentation-layout.tsx` (header logo).

## Deployment

The template ships a `Dockerfile`, a `fly.toml` (app `deploykit-docs`), and
example GitHub Actions workflows under `.github/workflows/`. These are **not**
wired into the root repo's CI. To publish the docs, review those workflows,
set the `FLY_API_TOKEN` secret, and adapt paths as needed — or host the
`build/` output anywhere that runs a Node server.
