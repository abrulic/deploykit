import { href, useNavigate } from "react-router"
import { Header } from "~/components/header"
import { Logo } from "~/components/logo"
import { Icon } from "~/ui/icon/icon"
import { getDomain } from "~/utils/get-domain"
import { generateMetaFields } from "~/utils/seo"
import { getLatestVersion } from "~/utils/version-resolvers"
import type { Route } from "./+types"

export const meta = ({ data }: Route.MetaArgs) => {
	const { domain } = data
	return generateMetaFields({
		domain,
		path: "/",
		title: "deploykit",
		description:
			"Automate CI/CD for Turbo and Nx monorepos deploying to Fly.io. One command generates Dockerfiles, fly.toml files and a GitHub Actions workflow — landed as a reviewable PR you own.",
	})
}

export async function loader({ request }: Route.LoaderArgs) {
	const { domain } = getDomain(request)
	return { domain }
}

type CardDef = {
	icon: React.ComponentProps<typeof Icon>["name"]
	title: string
	body: string
	href?: string
}

const CARDS: CardDef[] = [
	{
		icon: "Zap",
		title: "One command",
		body: "Run `deploykit init`: it reads your workspace graph, asks a few pre-filled questions, and shows a plan before writing anything.",
	},
	{
		icon: "FileText",
		title: "Files you own",
		body: "Generates multi-stage Dockerfiles, per-app fly.toml, and a GitHub Actions workflow — landed as a reviewable PR, not hidden magic.",
	},
	{
		icon: "Rocket",
		title: "Preview · staging · production",
		body: "Every PR gets its own deployed URL, staging deploys on merge to main, and production sits behind a manual approval gate.",
	},
	{
		icon: "ShieldCheck",
		title: "Health-checked rollbacks",
		body: "Fly waits on an HTTP health check before shifting traffic and keeps old machines on failure, so a bad deploy rolls itself back.",
	},
	{
		icon: "Clock",
		title: "Roll back a release",
		body: "`deploykit rollback` lists prior Fly releases for an environment and redeploys the image you pick, after showing the exact command.",
	},
	{
		icon: "Code",
		title: "Turbo & Nx aware",
		body: "Detects your package manager, framework, ports, internal deps, Prisma schemas and env-var names — turbo-prune based builds included.",
	},
]

function Card({ icon, title, body, href }: CardDef) {
	return (
		<a
			href={href}
			className="group block rounded-2xl border border-[var(--color-border)] bg-[var(--color-background)] p-6 transition-all hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#2c8794]"
		>
			<div className="mb-4 inline-flex size-12 items-center justify-center rounded-xl bg-gradient-to-r from-[#2c8794] to-[#329baa]">
				<Icon name={icon} className="size-6 text-white" />
			</div>
			<h3 className="mb-2 font-semibold text-[var(--color-text-active)] text-lg">{title}</h3>
			<p className="text-[var(--color-text-muted)] text-sm leading-relaxed">{body}</p>
			{href ? (
				<span className="mt-3 inline-flex items-center gap-1 font-medium text-[var(--color-text-active)] text-sm">
					Learn more <Icon name="ChevronRight" className="size-4" />
				</span>
			) : null}
		</a>
	)
}

//  FIXME Customize this page
export default function Index() {
	const navigate = useNavigate()

	return (
		<div className="flex min-h-screen flex-col bg-[var(--color-background)] 2xl:container 2xl:mx-auto">
			<Header>
				<Logo>
					<span className="p-0">deploykit</span>
				</Logo>
			</Header>

			<main className="flex flex-1 items-center justify-center">
				<div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-8 px-6 text-center">
					<div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-info-border)] bg-[var(--color-info-bg)] px-3 py-1 text-[var(--color-info-text)] text-sm">
						<Icon name="Zap" className="size-4" />
						Version {getLatestVersion()} now available
					</div>

					<h1 className="font-bold text-2xl text-[var(--color-text-active)] leading-snug md:text-3xl xl:text-4xl">
						CI/CD for your monorepo{" "}
						<span className="bg-gradient-to-r from-[#48ddf3] to-[#fb4bb5] bg-clip-text text-transparent">
							in one command
						</span>
					</h1>

					<p className="max-w-2xl text-[var(--color-text-muted)] text-lg leading-relaxed">
						deploykit reads your Turbo or Nx workspace and generates the Dockerfiles, fly.toml files and GitHub Actions
						workflow to deploy every app to Fly.io — preview, staging and production — landed as a PR you review and own.
					</p>

					<div className="mb-2 grid w-full gap-6 sm:grid-cols-2 lg:grid-cols-3">
						{CARDS.map((c) => (
							<Card key={c.title} {...c} />
						))}
					</div>

					<div className="mt-6 flex items-center justify-center gap-4">
						<button
							type="button"
							onClick={() => navigate(href("/:version?/home"))}
							className="flex items-center gap-2 rounded-lg bg-[#2c8794] px-6 py-3 font-medium text-white transition-colors hover:bg-[#329baa]"
						>
							<Icon name="Rocket" className="size-5" />
							Get started
						</button>

						<a
							href="https://github.com/abrulic/deploykit"
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-2 rounded-lg bg-[var(--color-background-active)] px-6 py-3 font-medium text-[var(--color-text-active)] transition-colors hover:bg-[var(--color-border)]"
						>
							<Icon name="Github" className="size-5" />
							View on GitHub
						</a>
					</div>

					<p className="mt-8 text-[var(--color-text-muted)] text-sm">
						Docs built with the{" "}
						<a
							href="https://github.com/code-forge-io/docs"
							target="_blank"
							rel="noopener noreferrer"
							className="underline hover:text-[var(--color-text)]"
						>
							code-forge docs template
						</a>
					</p>
				</div>
			</main>
		</div>
	)
}
