/** @jsxImportSource @opentui/solid */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createTextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

import {
  buildBatchPrQuery,
  extractPrUrls,
  formatAge,
  isDisplayablePr,
  isRefreshablePr,
  isUnavailablePrError,
  latestPrs,
  morePrsLabel,
  normalizeBatchPrResponse,
  prSummaryTitle,
  shortTitle,
  upsertDiscoveredPrs,
  type DisplayFilterOptions,
  type TrackedPr,
} from "./helpers"

const execFileAsync = promisify(execFile)

const REFRESH_MS = 60_000
const KV_PREFIX = "pr-sidebar"
const MAX_VISIBLE_PRS = 5
const STRIKETHROUGH = createTextAttributes({ strikethrough: true })
const inFlight = new Set<string>()

type PrSidebarOptions = DisplayFilterOptions

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function normalizeOptions(options: unknown): PrSidebarOptions {
  if (!options || typeof options !== "object") return {}
  const input = options as Record<string, unknown>

  return {
    includeOwners: stringArray(input.includeOwners),
    excludeOwners: stringArray(input.excludeOwners),
    onlyCurrentUser: typeof input.onlyCurrentUser === "boolean" ? input.onlyCurrentUser : undefined,
  }
}

function kvKey(sessionID: string): string {
  return `${KV_PREFIX}:${sessionID}`
}

function readTracked(api: TuiPluginApi, sessionID: string): TrackedPr[] {
  const value = api.kv.get<TrackedPr[]>(kvKey(sessionID), [])
  return Array.isArray(value) ? value : []
}

function writeTracked(api: TuiPluginApi, sessionID: string, prs: TrackedPr[]): void {
  api.kv.set(kvKey(sessionID), prs)
}

function normalizeMessageTime(created: number): number {
  return created < 1_000_000_000_000 ? created * 1000 : created
}

function scanSession(api: TuiPluginApi, sessionID: string, options: PrSidebarOptions): TrackedPr[] {
  const discovered = []

  for (const message of api.state.session.messages(sessionID)) {
    const seenAt = normalizeMessageTime(message.time.created)
    for (const part of api.state.part(message.id)) {
      if (part.type === "text" || part.type === "reasoning") {
        discovered.push(...extractPrUrls(part.text).map((pr) => ({ ...pr, seenAt })))
      }
      if (part.type === "tool" && part.state.status === "completed") {
        discovered.push(...extractPrUrls(part.state.output).map((pr) => ({ ...pr, seenAt })))
        discovered.push(...extractPrUrls(part.state.title).map((pr) => ({ ...pr, seenAt })))
      }
      if (part.type === "subtask") {
        discovered.push(...extractPrUrls(part.prompt).map((pr) => ({ ...pr, seenAt })))
        discovered.push(...extractPrUrls(part.description).map((pr) => ({ ...pr, seenAt })))
      }
      if (part.type === "file" && part.source?.type === "resource") {
        discovered.push(...extractPrUrls(part.source.uri).map((pr) => ({ ...pr, seenAt })))
      }
    }
  }

  const next = upsertDiscoveredPrs(readTracked(api, sessionID), discovered, options)
  writeTracked(api, sessionID, next)
  return next
}

async function refreshPrs(api: TuiPluginApi, sessionID: string, prs: TrackedPr[]): Promise<void> {
  const now = Date.now()
  const stalePrs = prs.filter((pr) => !(pr.updatedAt && now - pr.updatedAt < REFRESH_MS) && !inFlight.has(pr.url))
  if (stalePrs.length === 0) return

  for (const pr of stalePrs) inFlight.add(pr.url)
  try {
    const { query, refs } = buildBatchPrQuery(stalePrs)
    let stdout = ""
    try {
      const result = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`])
      stdout = String(result.stdout)
    } catch (error) {
      const partialStdout = (error as { stdout?: unknown }).stdout
      if (typeof partialStdout !== "string" || partialStdout.length === 0) throw error
      stdout = partialStdout
    }

    const updatedByUrl = new Map(normalizeBatchPrResponse(refs, JSON.parse(stdout), now).map((pr) => [pr.url, pr]))
    writeTracked(
      api,
      sessionID,
      readTracked(api, sessionID).map((item) => updatedByUrl.get(item.url) ?? item),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const unavailable = isUnavailablePrError(message)
    const staleUrls = new Set(stalePrs.map((pr) => pr.url))
    writeTracked(
      api,
      sessionID,
      readTracked(api, sessionID).map((item) =>
        staleUrls.has(item.url) ? { ...item, updatedAt: now, error: message, unavailable } : item,
      ),
    )
  } finally {
    for (const pr of stalePrs) inFlight.delete(pr.url)
  }
}

function statusText(pr: TrackedPr): string {
  if (pr.error) return "status unavailable"
  if (pr.state === "MERGED") return ""
  if (pr.state === "CLOSED") return "CLOSED"

  const bits = []
  if (pr.reviewDecision === "APPROVED") bits.push("approved")
  if (pr.reviewDecision === "CHANGES_REQUESTED") bits.push("changes requested")
  if (pr.checks === "pass") bits.push("CI pass")
  if (pr.checks === "fail") bits.push("CI fail")
  if (pr.checks === "pending") bits.push("CI pending")
  if (pr.mergeStateStatus && pr.mergeStateStatus !== "UNKNOWN") bits.push(pr.mergeStateStatus.toLowerCase().replaceAll("_", " "))
  return bits.length > 0 ? bits.join(" / ") : "OPEN"
}

function statusColor(api: TuiPluginApi, pr: TrackedPr) {
  if (pr.error) return api.theme.current.warning
  if (pr.state === "MERGED") return api.theme.current.textMuted
  if (pr.checks === "pass") return api.theme.current.success
  if (pr.state === "CLOSED" || pr.checks === "fail" || pr.reviewDecision === "CHANGES_REQUESTED") {
    return api.theme.current.error
  }
  if (pr.checks === "pending") return api.theme.current.info
  return api.theme.current.textMuted
}

function rowColor(api: TuiPluginApi, pr: TrackedPr) {
  return pr.state === "MERGED" ? api.theme.current.textMuted : api.theme.current.text
}

function titleColor(api: TuiPluginApi, pr: TrackedPr) {
  return pr.state === "MERGED" ? api.theme.current.textMuted : api.theme.current.markdownLink
}

function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  execFile(command, args, () => {})
}

function View(props: { api: TuiPluginApi; sessionID: string; options: PrSidebarOptions }) {
  const [open, setOpen] = createSignal(true)
  const [tick, setTick] = createSignal(0)
  const theme = () => props.api.theme.current
  const prs = createMemo(() => {
    tick()
    return readTracked(props.api, props.sessionID)
  })
  const displayablePrs = createMemo(() => {
    const now = Date.now()
    return prs().filter((pr) => isDisplayablePr(pr, now, props.options))
  })
  const title = createMemo(() => prSummaryTitle(displayablePrs()))
  const visiblePrs = createMemo(() => latestPrs(displayablePrs(), MAX_VISIBLE_PRS))
  const overflowLabel = createMemo(() => morePrsLabel(displayablePrs().length, visiblePrs().length))

  const refresh = () => {
    const scanned = scanSession(props.api, props.sessionID, props.options)
    void refreshPrs(props.api, props.sessionID, scanned.filter(isRefreshablePr)).then(() => setTick((value) => value + 1))
    setTick((value) => value + 1)
  }

  onMount(() => {
    refresh()
    const interval = setInterval(refresh, REFRESH_MS)
    onCleanup(() => clearInterval(interval))
  })

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((value) => !value)}>
        <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text}>
          <b>{title()}</b>
        </text>
      </box>
      <Show when={open()}>
        <Show when={displayablePrs().length === 0}>
          <text fg={theme().textMuted}>No PRs seen this session</text>
        </Show>
        <For each={visiblePrs()}>
          {(pr) => (
            <box flexDirection="column">
              <text fg={rowColor(props.api, pr)} attributes={pr.state === "MERGED" ? STRIKETHROUGH : undefined}>
                #{pr.number} {pr.repo}
                {statusText(pr) ? <span style={{ fg: statusColor(props.api, pr) }}> {statusText(pr)}</span> : null}
              </text>
              <text
                fg={titleColor(props.api, pr)}
                attributes={pr.state === "MERGED" ? STRIKETHROUGH : undefined}
                onMouseUp={() => openUrl(pr.url)}
              >
                {shortTitle(pr.title ?? pr.headRefName ?? pr.url, 42)}
                <span style={{ fg: theme().textMuted }}> {formatAge(pr.seenAt)}</span>
              </text>
            </box>
          )}
        </For>
        <Show when={overflowLabel()}>
          <text fg={theme().textMuted}>{overflowLabel()}</text>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const normalizedOptions = normalizeOptions(options)

  api.slots.register({
    order: 240,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} sessionID={props.session_id} options={normalizedOptions} />
      },
    },
  })
}

export default {
  id: "pr-sidebar",
  tui,
}
