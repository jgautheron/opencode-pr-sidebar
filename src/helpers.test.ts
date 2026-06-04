import { describe, expect, it } from "bun:test"

import {
  buildBatchPrQuery,
  extractPrUrls,
  formatAge,
  isAllowedOwner,
  isDisplayablePr,
  isRefreshablePr,
  isUnavailablePrError,
  latestPrs,
  morePrsLabel,
  normalizeBatchPrResponse,
  normalizeCheckStatus,
  normalizePrView,
  prSummaryTitle,
  shortTitle,
  upsertDiscoveredPrs,
} from "./helpers"

describe("PR sidebar helpers", () => {
  it("extracts unique GitHub PR URLs from arbitrary text", () => {
    const text = [
      "Opened https://github.com/acme/widgets/pull/331",
      "also see https://github.com/acme/tools/pull/145.",
      "duplicate: https://github.com/acme/widgets/pull/331",
    ].join("\n")

    expect(extractPrUrls(text)).toEqual([
      { url: "https://github.com/acme/widgets/pull/331", owner: "acme", repo: "widgets", number: 331 },
      { url: "https://github.com/acme/tools/pull/145", owner: "acme", repo: "tools", number: 145 },
    ])
  })

  it("extracts PR URLs for repositories containing dots", () => {
    expect(extractPrUrls("https://github.com/example/repo.with.dots/pull/12")).toEqual([
      { url: "https://github.com/example/repo.with.dots/pull/12", owner: "example", repo: "repo.with.dots", number: 12 },
    ])
  })

  it("filters PRs by configured owners", () => {
    expect(isAllowedOwner({ owner: "acme" })).toBe(true)
    expect(isAllowedOwner({ owner: "acme" }, { includeOwners: ["ACME"] })).toBe(true)
    expect(isAllowedOwner({ owner: "example" }, { includeOwners: ["acme"] })).toBe(false)
    expect(isAllowedOwner({ owner: "acme" }, { excludeOwners: ["acme"] })).toBe(false)
  })

  it("identifies PRs that should be displayed", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)

    expect(
      isDisplayablePr({
        url: "https://github.com/acme/widgets/pull/1",
        owner: "acme",
        repo: "widgets",
        number: 1,
        isCurrentUserAuthor: true,
      }, now),
    ).toBe(true)
    expect(isDisplayablePr({ url: "https://github.com/acme/widgets/pull/1", owner: "acme", repo: "widgets", number: 1 }, now)).toBe(
      false,
    )
    expect(
      isDisplayablePr({ url: "https://github.com/acme/widgets/pull/1", owner: "acme", repo: "widgets", number: 1 }, now, {
        onlyCurrentUser: false,
      }),
    ).toBe(true)
    expect(
      isDisplayablePr({ url: "https://github.com/example/widgets/pull/1", owner: "example", repo: "widgets", number: 1 }, now, {
        includeOwners: ["acme"],
        onlyCurrentUser: false,
      }),
    ).toBe(false)
    expect(
      isDisplayablePr({
        url: "https://github.com/acme/widgets/pull/1",
        owner: "acme",
        repo: "widgets",
        number: 1,
        isCurrentUserAuthor: false,
      }, now),
    ).toBe(false)
    expect(
      isDisplayablePr({
        url: "https://github.com/acme/missing/pull/5",
        owner: "acme",
        repo: "missing",
        number: 5,
        unavailable: true,
      }, now),
    ).toBe(false)
    expect(
      isDisplayablePr({
        url: "https://github.com/acme/missing/pull/5",
        owner: "acme",
        repo: "missing",
        number: 5,
        error: "GraphQL: Could not resolve to a Repository with the name 'acme/missing'. (repository)",
      }, now),
    ).toBe(false)
    expect(
      isDisplayablePr({
        url: "https://github.com/acme/widgets/pull/2",
        owner: "acme",
        repo: "widgets",
        number: 2,
        state: "MERGED",
        isCurrentUserAuthor: true,
        mergedAt: now - 4 * 60 * 60_000 + 1,
      }, now),
    ).toBe(true)
    expect(
      isDisplayablePr({
        url: "https://github.com/acme/widgets/pull/3",
        owner: "acme",
        repo: "widgets",
        number: 3,
        state: "MERGED",
        isCurrentUserAuthor: true,
        mergedAt: now - 4 * 60 * 60_000,
      }, now),
    ).toBe(false)
  })

  it("refreshes unknown-author PRs while skipping unavailable PRs", () => {
    expect(isRefreshablePr({ url: "https://github.com/acme/widgets/pull/1", owner: "acme", repo: "widgets", number: 1 })).toBe(true)
    expect(isRefreshablePr({ url: "https://github.com/acme/missing/pull/5", owner: "acme", repo: "missing", number: 5, unavailable: true })).toBe(
      false,
    )
  })

  it("detects gh errors for inaccessible or missing PR repositories", () => {
    expect(isUnavailablePrError("GraphQL: Could not resolve to a Repository with the name 'acme/missing'. (repository)")).toBe(true)
    expect(isUnavailablePrError("GraphQL: Could not resolve to a PullRequest with the number of 5. (repository.pullRequest)")).toBe(true)
    expect(isUnavailablePrError("HTTP 404: Not Found")).toBe(true)
    expect(isUnavailablePrError("network timeout while contacting api.github.com")).toBe(false)
  })

  it("normalizes check rollup into pass, fail, pending, or unknown", () => {
    expect(normalizeCheckStatus([])).toBe("unknown")
    expect(normalizeCheckStatus([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pass")
    expect(normalizeCheckStatus([{ status: "COMPLETED", conclusion: "FAILURE" }])).toBe("fail")
    expect(normalizeCheckStatus([{ status: "IN_PROGRESS", conclusion: null }])).toBe("pending")
  })

  it("normalizes gh pr view JSON while preserving discovery fields", () => {
    const pr = normalizePrView(
      { url: "https://github.com/acme/widgets/pull/331", owner: "acme", repo: "widgets", number: 331 },
      {
        title: "feat(symlink): add opencode agent links",
        state: "MERGED",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNKNOWN",
        headRefName: "jon/beplat-4373-opencode-agents",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      123,
    )

    expect(pr).toMatchObject({
      repo: "widgets",
      number: 331,
      title: "feat(symlink): add opencode agent links",
      state: "MERGED",
      reviewDecision: "APPROVED",
      checks: "pass",
      updatedAt: 123,
    })
  })

  it("builds one GraphQL query for multiple PRs", () => {
    const batch = buildBatchPrQuery([
      { url: "https://github.com/acme/widgets/pull/331", owner: "acme", repo: "widgets", number: 331 },
      { url: "https://github.com/acme/tools/pull/145", owner: "acme", repo: "tools", number: 145 },
    ])

    expect(batch.refs).toEqual({
      pr0: { url: "https://github.com/acme/widgets/pull/331", owner: "acme", repo: "widgets", number: 331 },
      pr1: { url: "https://github.com/acme/tools/pull/145", owner: "acme", repo: "tools", number: 145 },
    })
    expect(batch.query).toContain('pr0: repository(owner: "acme", name: "widgets")')
    expect(batch.query).toContain("pullRequest(number: 331)")
    expect(batch.query).toContain("viewer")
    expect(batch.query).toContain("author")
    expect(batch.query).toContain("mergedAt")
    expect(batch.query).toContain('pr1: repository(owner: "acme", name: "tools")')
    expect(batch.query).toContain("pullRequest(number: 145)")
    expect(batch.query).toContain("statusCheckRollup")
  })

  it("normalizes batched GraphQL responses and hides unavailable PRs", () => {
    const refs = buildBatchPrQuery([
      { url: "https://github.com/acme/widgets/pull/331", owner: "acme", repo: "widgets", number: 331 },
      { url: "https://github.com/acme/missing/pull/5", owner: "acme", repo: "missing", number: 5 },
    ]).refs

    expect(
      normalizeBatchPrResponse(
        refs,
        {
          data: {
            viewer: { login: "jooon" },
            pr0: {
              pullRequest: {
                title: "feat: test",
                state: "OPEN",
                author: { login: "jooon" },
                mergedAt: null,
                reviewDecision: "APPROVED",
                mergeStateStatus: "CLEAN",
                headRefName: "jon/test",
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
                      { __typename: "StatusContext", state: "SUCCESS" },
                    ],
                  },
                },
              },
            },
            pr1: null,
          },
          errors: [{ path: ["pr1"], message: "Could not resolve to a Repository with the name 'acme/missing'." }],
        },
        123,
      ),
    ).toEqual([
      {
        url: "https://github.com/acme/widgets/pull/331",
        owner: "acme",
        repo: "widgets",
        number: 331,
        title: "feat: test",
        state: "OPEN",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        headRefName: "jon/test",
        authorLogin: "jooon",
        isCurrentUserAuthor: true,
        mergedAt: undefined,
        checks: "pass",
        updatedAt: 123,
      },
      {
        url: "https://github.com/acme/missing/pull/5",
        owner: "acme",
        repo: "missing",
        number: 5,
        updatedAt: 123,
        error: "Could not resolve to a Repository with the name 'acme/missing'.",
        unavailable: true,
      },
    ])
  })

  it("marks PRs authored by other users as hidden", () => {
    const refs = buildBatchPrQuery([{ url: "https://github.com/acme/widgets/pull/331", owner: "acme", repo: "widgets", number: 331 }]).refs

    expect(
      normalizeBatchPrResponse(
        refs,
        {
          data: {
            viewer: { login: "jooon" },
            pr0: {
              pullRequest: {
                title: "feat: test",
                state: "MERGED",
                author: { login: "dependabot" },
                mergedAt: "2026-01-01T12:00:00Z",
                statusCheckRollup: { contexts: { nodes: [] } },
              },
            },
          },
        },
        123,
      )[0],
    ).toMatchObject({ authorLogin: "dependabot", isCurrentUserAuthor: false, mergedAt: Date.UTC(2026, 0, 1, 12, 0, 0) })
  })

  it("upserts newly discovered PRs without losing existing status", () => {
    const existing = [
      {
        url: "https://github.com/acme/widgets/pull/331",
        owner: "acme",
        repo: "widgets",
        number: 331,
        state: "MERGED" as const,
        checks: "pass" as const,
      },
    ]

    const next = upsertDiscoveredPrs(existing, [
      { url: "https://github.com/acme/widgets/pull/331", owner: "acme", repo: "widgets", number: 331 },
      { url: "https://github.com/acme/tools/pull/145", owner: "acme", repo: "tools", number: 145 },
    ])

    expect(next).toEqual([
      existing[0],
      { url: "https://github.com/acme/tools/pull/145", owner: "acme", repo: "tools", number: 145 },
    ])
  })

  it("shortens long PR titles for sidebar display", () => {
    expect(shortTitle("short title", 20)).toBe("short title")
    expect(shortTitle("this title is much too long for the sidebar", 20)).toBe("this title is muc...")
  })

  it("builds a readable PR sidebar summary title", () => {
    expect(
      prSummaryTitle([
        {
          url: "https://github.com/acme/a/pull/1",
          owner: "acme",
          repo: "a",
          number: 1,
          checks: "pass",
          reviewDecision: "APPROVED",
        },
        {
          url: "https://github.com/acme/b/pull/2",
          owner: "acme",
          repo: "b",
          number: 2,
          checks: "pass",
          reviewDecision: "APPROVED",
        },
        {
          url: "https://github.com/acme/c/pull/3",
          owner: "acme",
          repo: "c",
          number: 3,
          state: "MERGED",
        },
        {
          url: "https://github.com/acme/d/pull/4",
          owner: "acme",
          repo: "d",
          number: 4,
          state: "MERGED",
        },
        {
          url: "https://github.com/acme/e/pull/5",
          owner: "acme",
          repo: "e",
          number: 5,
          state: "MERGED",
        },
        {
          url: "https://github.com/acme/f/pull/6",
          owner: "acme",
          repo: "f",
          number: 6,
          state: "OPEN",
          reviewDecision: "REVIEW_REQUIRED",
        },
      ]),
    ).toBe("PRs (6 total, 2 approved, 3 merged)")
  })

  it("omits zero counts from the PR sidebar summary title", () => {
    expect(prSummaryTitle([])).toBe("PRs")
    expect(
      prSummaryTitle([
        {
          url: "https://github.com/acme/a/pull/1",
          owner: "acme",
          repo: "a",
          number: 1,
          state: "MERGED",
        },
      ]),
    ).toBe("PRs (1 total, 0 approved, 1 merged)")
  })

  it("applies configured owner filters while upserting", () => {
    expect(
      upsertDiscoveredPrs([], [
        { url: "https://github.com/acme/widgets/pull/1", owner: "acme", repo: "widgets", number: 1 },
        { url: "https://github.com/example/repo/pull/2", owner: "example", repo: "repo", number: 2 },
      ], { includeOwners: ["acme"] }).map((pr) => pr.url),
    ).toEqual(["https://github.com/acme/widgets/pull/1"])
  })

  it("sorts PRs newest-first and limits visible rows", () => {
    expect(
      latestPrs(
        [1, 2, 3, 4, 5, 6].map((number) => ({
          url: `https://github.com/acme/repo/pull/${number}`,
          owner: "acme",
          repo: "repo",
          number,
          seenAt: number * 1000,
        })),
        5,
      ).map((pr) => pr.number),
    ).toEqual([6, 5, 4, 3, 2])
  })

  it("formats overflow labels for hidden PRs", () => {
    expect(morePrsLabel(5, 5)).toBeUndefined()
    expect(morePrsLabel(6, 5)).toBe("... 1 more PR")
    expect(morePrsLabel(10, 5)).toBe("... 5 more PRs")
  })

  it("formats compact relative ages", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)

    expect(formatAge(undefined, now)).toBeUndefined()
    expect(formatAge(now - 20_000, now)).toBe("now")
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m ago")
    expect(formatAge(now - 2 * 60 * 60_000, now)).toBe("2h ago")
    expect(formatAge(now - 3 * 24 * 60 * 60_000, now)).toBe("3d ago")
  })
})
