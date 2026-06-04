export type DiscoveredPr = {
  url: string
  owner: string
  repo: string
  number: number
  seenAt?: number
}

export type CheckStatus = "pass" | "fail" | "pending" | "unknown"

export type OwnerFilterOptions = {
  includeOwners?: string[]
  excludeOwners?: string[]
}

export type DisplayFilterOptions = OwnerFilterOptions & {
  onlyCurrentUser?: boolean
}

export type TrackedPr = DiscoveredPr & {
  title?: string
  state?: "OPEN" | "MERGED" | "CLOSED"
  reviewDecision?: string
  mergeStateStatus?: string
  headRefName?: string
  mergedAt?: number
  authorLogin?: string
  isCurrentUserAuthor?: boolean
  checks?: CheckStatus
  updatedAt?: number
  error?: string
  unavailable?: boolean
}

type GhCheck = {
  status?: string | null
  conclusion?: string | null
}

type GhPrView = {
  title?: string
  state?: "OPEN" | "MERGED" | "CLOSED"
  reviewDecision?: string | null
  mergeStateStatus?: string | null
  headRefName?: string | null
  mergedAt?: string | null
  statusCheckRollup?: GhCheck[] | null
}

type GraphqlStatusContext = GhCheck & {
  __typename?: string
  state?: string | null
}

type GraphqlPrView = Omit<GhPrView, "statusCheckRollup"> & {
  author?: {
    login?: string | null
  } | null
  statusCheckRollup?: {
    contexts?: {
      nodes?: GraphqlStatusContext[] | null
    } | null
  } | null
}

type GraphqlBatchResponse = {
  data?: {
    viewer?: { login?: string | null } | null
  } & Record<string, { pullRequest?: GraphqlPrView | null } | { login?: string | null } | null | undefined>
  errors?: { path?: Array<string | number>; message?: string }[]
}

export type BatchPrQuery = {
  query: string
  refs: Record<string, DiscoveredPr>
}

const PR_URL_RE = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g
const MERGED_PR_RETENTION_MS = 4 * 60 * 60_000

export function extractPrUrls(text: string): DiscoveredPr[] {
  const seen = new Set<string>()
  const prs: DiscoveredPr[] = []

  for (const match of text.matchAll(PR_URL_RE)) {
    const owner = match[1]
    const repo = match[2]
    const number = Number(match[3])
    const url = `https://github.com/${owner}/${repo}/pull/${number}`
    if (seen.has(url)) continue

    seen.add(url)
    prs.push({ url, owner, repo, number })
  }

  return prs
}

function normalizedOwnerSet(owners: string[] | undefined): Set<string> {
  return new Set((owners ?? []).map((owner) => owner.trim().toLowerCase()).filter(Boolean))
}

export function isAllowedOwner(pr: Pick<DiscoveredPr, "owner">, options: OwnerFilterOptions = {}): boolean {
  const owner = pr.owner.toLowerCase()
  const includeOwners = normalizedOwnerSet(options.includeOwners)
  const excludeOwners = normalizedOwnerSet(options.excludeOwners)

  if (excludeOwners.has(owner)) return false
  return includeOwners.size === 0 || includeOwners.has(owner)
}

export function isDisplayablePr(pr: Partial<TrackedPr>, now = Date.now(), options: DisplayFilterOptions = {}): boolean {
  if (!isRefreshablePr(pr)) return false
  if (pr.owner && !isAllowedOwner(pr as Pick<DiscoveredPr, "owner">, options)) return false
  if (options.onlyCurrentUser !== false && pr.isCurrentUserAuthor !== true) return false
  if (pr.state !== "MERGED" || pr.mergedAt == null) return true
  return now - pr.mergedAt < MERGED_PR_RETENTION_MS
}

export function isRefreshablePr(pr: Partial<TrackedPr>): boolean {
  return pr.unavailable !== true && !isUnavailablePrError(pr.error ?? "")
}

export function isUnavailablePrError(message: string): boolean {
  return (
    message.includes("Could not resolve to a Repository") ||
    message.includes("Could not resolve to a PullRequest") ||
    message.includes("HTTP 404") ||
    message.includes("Not Found")
  )
}

export function normalizeCheckStatus(checks: GhCheck[] | null | undefined): CheckStatus {
  if (!checks || checks.length === 0) return "unknown"

  if (checks.some((check) => ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(check.conclusion ?? ""))) {
    return "fail"
  }

  if (checks.some((check) => check.status !== "COMPLETED" || !check.conclusion)) return "pending"

  if (checks.every((check) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion ?? ""))) return "pass"

  return "unknown"
}

export function normalizePrView(discovered: DiscoveredPr, view: GhPrView, now = Date.now()): TrackedPr {
  return {
    ...discovered,
    title: view.title,
    state: view.state,
    reviewDecision: view.reviewDecision ?? undefined,
    mergeStateStatus: view.mergeStateStatus ?? undefined,
    headRefName: view.headRefName ?? undefined,
    mergedAt: view.mergedAt ? Date.parse(view.mergedAt) : undefined,
    checks: normalizeCheckStatus(view.statusCheckRollup),
    seenAt: discovered.seenAt,
    updatedAt: now,
  }
}

function normalizeGraphqlStatusContext(context: GraphqlStatusContext): GhCheck {
  if (context.status || context.conclusion) return { status: context.status, conclusion: context.conclusion }

  if (context.state === "SUCCESS") return { status: "COMPLETED", conclusion: "SUCCESS" }
  if (context.state === "FAILURE" || context.state === "ERROR") return { status: "COMPLETED", conclusion: "FAILURE" }
  return { status: context.state ?? undefined, conclusion: null }
}

function normalizeGraphqlPrView(discovered: DiscoveredPr, view: GraphqlPrView, viewerLogin: string | undefined, now = Date.now()): TrackedPr {
  const authorLogin = view.author?.login ?? undefined
  return {
    ...normalizePrView(
      discovered,
      {
        ...view,
        statusCheckRollup: view.statusCheckRollup?.contexts?.nodes?.map(normalizeGraphqlStatusContext) ?? null,
      },
      now,
    ),
    authorLogin,
    isCurrentUserAuthor: viewerLogin != null && authorLogin === viewerLogin,
  }
}

export function buildBatchPrQuery(prs: DiscoveredPr[]): BatchPrQuery {
  const refs: Record<string, DiscoveredPr> = {}
  const fields = prs.map((pr, index) => {
    const alias = `pr${index}`
    refs[alias] = pr

    return `${alias}: repository(owner: ${JSON.stringify(pr.owner)}, name: ${JSON.stringify(pr.repo)}) {
      pullRequest(number: ${pr.number}) {
        title
        state
        mergedAt
        author {
          login
        }
        reviewDecision
        mergeStateStatus
        headRefName
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                status
                conclusion
              }
              ... on StatusContext {
                state
              }
            }
          }
        }
      }
    }`
  })

  return { refs, query: `query {\nviewer {\nlogin\n}\n${fields.join("\n")}\n}` }
}

export function normalizeBatchPrResponse(
  refs: Record<string, DiscoveredPr>,
  response: GraphqlBatchResponse,
  now = Date.now(),
): TrackedPr[] {
  const errorsByAlias = new Map<string, string>()
  const viewerLogin = response.data?.viewer?.login ?? undefined
  for (const error of response.errors ?? []) {
    const alias = typeof error.path?.[0] === "string" ? error.path[0] : undefined
    if (alias && error.message) errorsByAlias.set(alias, error.message)
  }

  return Object.entries(refs).map(([alias, pr]) => {
    const value = response.data?.[alias]
    const view = value && "pullRequest" in value ? value.pullRequest : undefined
    if (view) return normalizeGraphqlPrView(pr, view, viewerLogin, now)

    const error = errorsByAlias.get(alias) ?? "Pull request unavailable"
    return {
      ...pr,
      updatedAt: now,
      error,
      unavailable: true,
    }
  })
}

export function upsertDiscoveredPrs(existing: TrackedPr[], discovered: DiscoveredPr[], options: OwnerFilterOptions = {}): TrackedPr[] {
  const byUrl = new Map(existing.filter((pr) => isAllowedOwner(pr, options)).map((pr) => [pr.url, pr]))

  for (const pr of discovered.filter((item) => isAllowedOwner(item, options))) {
    const current = byUrl.get(pr.url)
    if (!current) {
      byUrl.set(pr.url, pr)
      continue
    }
    byUrl.set(pr.url, {
      ...current,
      seenAt: Math.max(current.seenAt ?? 0, pr.seenAt ?? 0) || current.seenAt,
    })
  }

  return [...byUrl.values()]
}

export function shortTitle(title: string | undefined, max = 44): string {
  if (!title) return "(untitled)"
  if (title.length <= max) return title
  return `${title.slice(0, Math.max(0, max - 3))}...`
}

export function prSummaryTitle(prs: TrackedPr[]): string {
  const approved = prs.filter((pr) => pr.reviewDecision === "APPROVED").length
  const merged = prs.filter((pr) => pr.state === "MERGED").length
  if (prs.length === 0) return "PRs"

  return `PRs (${prs.length} total, ${approved} approved, ${merged} merged)`
}

export function latestPrs(prs: TrackedPr[], limit = 5): TrackedPr[] {
  return [...prs]
    .sort((a, b) => (b.seenAt ?? b.updatedAt ?? 0) - (a.seenAt ?? a.updatedAt ?? 0))
    .slice(0, limit)
}

export function morePrsLabel(total: number, shown: number): string | undefined {
  const hidden = total - shown
  if (hidden <= 0) return undefined
  return `... ${hidden} more PR${hidden === 1 ? "" : "s"}`
}

export function formatAge(timestamp: number | undefined, now = Date.now()): string | undefined {
  if (!timestamp) return undefined
  const elapsedMs = Math.max(0, now - timestamp)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
