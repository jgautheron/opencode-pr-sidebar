// @bun
// src/tui.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { execFile } from "child_process";
import { promisify } from "util";
import { createTextAttributes } from "@opentui/core";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

// src/helpers.ts
var PR_URL_RE = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;
var MERGED_PR_RETENTION_MS = 4 * 60 * 60000;
function extractPrUrls(text) {
  const seen = new Set;
  const prs = [];
  for (const match of text.matchAll(PR_URL_RE)) {
    const owner = match[1];
    const repo = match[2];
    const number = Number(match[3]);
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;
    if (seen.has(url))
      continue;
    seen.add(url);
    prs.push({ url, owner, repo, number });
  }
  return prs;
}
function normalizedOwnerSet(owners) {
  return new Set((owners ?? []).map((owner) => owner.trim().toLowerCase()).filter(Boolean));
}
function isAllowedOwner(pr, options = {}) {
  const owner = pr.owner.toLowerCase();
  const includeOwners = normalizedOwnerSet(options.includeOwners);
  const excludeOwners = normalizedOwnerSet(options.excludeOwners);
  if (excludeOwners.has(owner))
    return false;
  return includeOwners.size === 0 || includeOwners.has(owner);
}
function isDisplayablePr(pr, now = Date.now(), options = {}) {
  if (!isRefreshablePr(pr))
    return false;
  if (pr.owner && !isAllowedOwner(pr, options))
    return false;
  if (options.onlyCurrentUser !== false && pr.isCurrentUserAuthor !== true)
    return false;
  if (pr.state !== "MERGED" || pr.mergedAt == null)
    return true;
  return now - pr.mergedAt < MERGED_PR_RETENTION_MS;
}
function isRefreshablePr(pr) {
  return pr.unavailable !== true && !isUnavailablePrError(pr.error ?? "");
}
function isUnavailablePrError(message) {
  return message.includes("Could not resolve to a Repository") || message.includes("Could not resolve to a PullRequest") || message.includes("HTTP 404") || message.includes("Not Found");
}
function normalizeCheckStatus(checks) {
  if (!checks || checks.length === 0)
    return "unknown";
  if (checks.some((check) => ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(check.conclusion ?? ""))) {
    return "fail";
  }
  if (checks.some((check) => check.status !== "COMPLETED" || !check.conclusion))
    return "pending";
  if (checks.every((check) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion ?? "")))
    return "pass";
  return "unknown";
}
function normalizePrView(discovered, view, now = Date.now()) {
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
    updatedAt: now
  };
}
function normalizeGraphqlStatusContext(context) {
  if (context.status || context.conclusion)
    return { status: context.status, conclusion: context.conclusion };
  if (context.state === "SUCCESS")
    return { status: "COMPLETED", conclusion: "SUCCESS" };
  if (context.state === "FAILURE" || context.state === "ERROR")
    return { status: "COMPLETED", conclusion: "FAILURE" };
  return { status: context.state ?? undefined, conclusion: null };
}
function normalizeGraphqlPrView(discovered, view, viewerLogin, now = Date.now()) {
  const authorLogin = view.author?.login ?? undefined;
  return {
    ...normalizePrView(discovered, {
      ...view,
      statusCheckRollup: view.statusCheckRollup?.contexts?.nodes?.map(normalizeGraphqlStatusContext) ?? null
    }, now),
    authorLogin,
    isCurrentUserAuthor: viewerLogin != null && authorLogin === viewerLogin
  };
}
function buildBatchPrQuery(prs) {
  const refs = {};
  const fields = prs.map((pr, index) => {
    const alias = `pr${index}`;
    refs[alias] = pr;
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
    }`;
  });
  return { refs, query: `query {
viewer {
login
}
${fields.join(`
`)}
}` };
}
function normalizeBatchPrResponse(refs, response, now = Date.now()) {
  const errorsByAlias = new Map;
  const viewerLogin = response.data?.viewer?.login ?? undefined;
  for (const error of response.errors ?? []) {
    const alias = typeof error.path?.[0] === "string" ? error.path[0] : undefined;
    if (alias && error.message)
      errorsByAlias.set(alias, error.message);
  }
  return Object.entries(refs).map(([alias, pr]) => {
    const value = response.data?.[alias];
    const view = value && "pullRequest" in value ? value.pullRequest : undefined;
    if (view)
      return normalizeGraphqlPrView(pr, view, viewerLogin, now);
    const error = errorsByAlias.get(alias) ?? "Pull request unavailable";
    return {
      ...pr,
      updatedAt: now,
      error,
      unavailable: true
    };
  });
}
function upsertDiscoveredPrs(existing, discovered, options = {}) {
  const byUrl = new Map(existing.filter((pr) => isAllowedOwner(pr, options)).map((pr) => [pr.url, pr]));
  for (const pr of discovered.filter((item) => isAllowedOwner(item, options))) {
    const current = byUrl.get(pr.url);
    if (!current) {
      byUrl.set(pr.url, pr);
      continue;
    }
    byUrl.set(pr.url, {
      ...current,
      seenAt: Math.max(current.seenAt ?? 0, pr.seenAt ?? 0) || current.seenAt
    });
  }
  return [...byUrl.values()];
}
function shortTitle(title, max = 44) {
  if (!title)
    return "(untitled)";
  if (title.length <= max)
    return title;
  return `${title.slice(0, Math.max(0, max - 3))}...`;
}
function prSummaryTitle(prs) {
  const approved = prs.filter((pr) => pr.reviewDecision === "APPROVED").length;
  const merged = prs.filter((pr) => pr.state === "MERGED").length;
  if (prs.length === 0)
    return "PRs";
  return `PRs (${prs.length} total, ${approved} approved, ${merged} merged)`;
}
function latestPrs(prs, limit = 5) {
  return [...prs].sort((a, b) => (b.seenAt ?? b.updatedAt ?? 0) - (a.seenAt ?? a.updatedAt ?? 0)).slice(0, limit);
}
function morePrsLabel(total, shown) {
  const hidden = total - shown;
  if (hidden <= 0)
    return;
  return `... ${hidden} more PR${hidden === 1 ? "" : "s"}`;
}
function formatAge(timestamp, now = Date.now()) {
  if (!timestamp)
    return;
  const elapsedMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1)
    return "now";
  if (minutes < 60)
    return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// src/tui.tsx
var execFileAsync = promisify(execFile);
var REFRESH_MS = 60000;
var KV_PREFIX = "pr-sidebar";
var MAX_VISIBLE_PRS = 5;
var STRIKETHROUGH = createTextAttributes({
  strikethrough: true
});
var inFlight = new Set;
function stringArray(value) {
  if (!Array.isArray(value))
    return;
  return value.filter((item) => typeof item === "string");
}
function normalizeOptions(options) {
  if (!options || typeof options !== "object")
    return {};
  const input = options;
  return {
    includeOwners: stringArray(input.includeOwners),
    excludeOwners: stringArray(input.excludeOwners),
    onlyCurrentUser: typeof input.onlyCurrentUser === "boolean" ? input.onlyCurrentUser : undefined
  };
}
function kvKey(sessionID) {
  return `${KV_PREFIX}:${sessionID}`;
}
function readTracked(api, sessionID) {
  const value = api.kv.get(kvKey(sessionID), []);
  return Array.isArray(value) ? value : [];
}
function writeTracked(api, sessionID, prs) {
  api.kv.set(kvKey(sessionID), prs);
}
function normalizeMessageTime(created) {
  return created < 1000000000000 ? created * 1000 : created;
}
function scanSession(api, sessionID, options) {
  const discovered = [];
  for (const message of api.state.session.messages(sessionID)) {
    const seenAt = normalizeMessageTime(message.time.created);
    for (const part of api.state.part(message.id)) {
      if (part.type === "text" || part.type === "reasoning") {
        discovered.push(...extractPrUrls(part.text).map((pr) => ({
          ...pr,
          seenAt
        })));
      }
      if (part.type === "tool" && part.state.status === "completed") {
        discovered.push(...extractPrUrls(part.state.output).map((pr) => ({
          ...pr,
          seenAt
        })));
        discovered.push(...extractPrUrls(part.state.title).map((pr) => ({
          ...pr,
          seenAt
        })));
      }
      if (part.type === "subtask") {
        discovered.push(...extractPrUrls(part.prompt).map((pr) => ({
          ...pr,
          seenAt
        })));
        discovered.push(...extractPrUrls(part.description).map((pr) => ({
          ...pr,
          seenAt
        })));
      }
      if (part.type === "file" && part.source?.type === "resource") {
        discovered.push(...extractPrUrls(part.source.uri).map((pr) => ({
          ...pr,
          seenAt
        })));
      }
    }
  }
  const next = upsertDiscoveredPrs(readTracked(api, sessionID), discovered, options);
  writeTracked(api, sessionID, next);
  return next;
}
async function refreshPrs(api, sessionID, prs) {
  const now = Date.now();
  const stalePrs = prs.filter((pr) => !(pr.updatedAt && now - pr.updatedAt < REFRESH_MS) && !inFlight.has(pr.url));
  if (stalePrs.length === 0)
    return;
  for (const pr of stalePrs)
    inFlight.add(pr.url);
  try {
    const {
      query,
      refs
    } = buildBatchPrQuery(stalePrs);
    let stdout = "";
    try {
      const result = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`]);
      stdout = String(result.stdout);
    } catch (error) {
      const partialStdout = error.stdout;
      if (typeof partialStdout !== "string" || partialStdout.length === 0)
        throw error;
      stdout = partialStdout;
    }
    const updatedByUrl = new Map(normalizeBatchPrResponse(refs, JSON.parse(stdout), now).map((pr) => [pr.url, pr]));
    writeTracked(api, sessionID, readTracked(api, sessionID).map((item) => updatedByUrl.get(item.url) ?? item));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = isUnavailablePrError(message);
    const staleUrls = new Set(stalePrs.map((pr) => pr.url));
    writeTracked(api, sessionID, readTracked(api, sessionID).map((item) => staleUrls.has(item.url) ? {
      ...item,
      updatedAt: now,
      error: message,
      unavailable
    } : item));
  } finally {
    for (const pr of stalePrs)
      inFlight.delete(pr.url);
  }
}
function statusText(pr) {
  if (pr.error)
    return "status unavailable";
  if (pr.state === "MERGED")
    return "";
  if (pr.state === "CLOSED")
    return "CLOSED";
  const bits = [];
  if (pr.reviewDecision === "APPROVED")
    bits.push("approved");
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    bits.push("changes requested");
  if (pr.checks === "pass")
    bits.push("CI pass");
  if (pr.checks === "fail")
    bits.push("CI fail");
  if (pr.checks === "pending")
    bits.push("CI pending");
  if (pr.mergeStateStatus && pr.mergeStateStatus !== "UNKNOWN")
    bits.push(pr.mergeStateStatus.toLowerCase().replaceAll("_", " "));
  return bits.length > 0 ? bits.join(" / ") : "OPEN";
}
function statusColor(api, pr) {
  if (pr.error)
    return api.theme.current.warning;
  if (pr.state === "MERGED")
    return api.theme.current.textMuted;
  if (pr.checks === "pass")
    return api.theme.current.success;
  if (pr.state === "CLOSED" || pr.checks === "fail" || pr.reviewDecision === "CHANGES_REQUESTED") {
    return api.theme.current.error;
  }
  if (pr.checks === "pending")
    return api.theme.current.info;
  return api.theme.current.textMuted;
}
function rowColor(api, pr) {
  return pr.state === "MERGED" ? api.theme.current.textMuted : api.theme.current.text;
}
function titleColor(api, pr) {
  return pr.state === "MERGED" ? api.theme.current.textMuted : api.theme.current.markdownLink;
}
function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, () => {});
}
function View(props) {
  const [open, setOpen] = createSignal(true);
  const [tick, setTick] = createSignal(0);
  const theme = () => props.api.theme.current;
  const prs = createMemo(() => {
    tick();
    return readTracked(props.api, props.sessionID);
  });
  const displayablePrs = createMemo(() => {
    const now = Date.now();
    return prs().filter((pr) => isDisplayablePr(pr, now, props.options));
  });
  const title = createMemo(() => prSummaryTitle(displayablePrs()));
  const visiblePrs = createMemo(() => latestPrs(displayablePrs(), MAX_VISIBLE_PRS));
  const overflowLabel = createMemo(() => morePrsLabel(displayablePrs().length, visiblePrs().length));
  const refresh = () => {
    const scanned = scanSession(props.api, props.sessionID, props.options);
    refreshPrs(props.api, props.sessionID, scanned.filter(isRefreshablePr)).then(() => setTick((value) => value + 1));
    setTick((value) => value + 1);
  };
  onMount(() => {
    refresh();
    const interval = setInterval(refresh, REFRESH_MS);
    onCleanup(() => clearInterval(interval));
  });
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("text"), _el$5 = _$createElement("b");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$4);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "gap", 1);
    _$setProp(_el$2, "onMouseDown", () => setOpen((value) => !value));
    _$insert(_el$3, () => open() ? "\u25BC" : "\u25B6");
    _$insertNode(_el$4, _el$5);
    _$insert(_el$5, title);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return open();
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return displayablePrs().length === 0;
          },
          get children() {
            var _el$6 = _$createElement("text");
            _$insertNode(_el$6, _$createTextNode(`No PRs seen this session`));
            _$effect((_$p) => _$setProp(_el$6, "fg", theme().textMuted, _$p));
            return _el$6;
          }
        }), _$createComponent(For, {
          get each() {
            return visiblePrs();
          },
          children: (pr) => (() => {
            var _el$9 = _$createElement("box"), _el$0 = _$createElement("text"), _el$1 = _$createTextNode(`#`), _el$10 = _$createTextNode(` `), _el$11 = _$createElement("text"), _el$12 = _$createElement("span"), _el$13 = _$createTextNode(` `);
            _$insertNode(_el$9, _el$0);
            _$insertNode(_el$9, _el$11);
            _$setProp(_el$9, "flexDirection", "column");
            _$insertNode(_el$0, _el$1);
            _$insertNode(_el$0, _el$10);
            _$insert(_el$0, () => pr.number, _el$10);
            _$insert(_el$0, () => pr.repo, null);
            _$insert(_el$0, (() => {
              var _c$ = _$memo(() => !!statusText(pr));
              return () => _c$() ? (() => {
                var _el$14 = _$createElement("span"), _el$15 = _$createTextNode(` `);
                _$insertNode(_el$14, _el$15);
                _$insert(_el$14, () => statusText(pr), null);
                _$effect((_$p) => _$setProp(_el$14, "style", {
                  fg: statusColor(props.api, pr)
                }, _$p));
                return _el$14;
              })() : null;
            })(), null);
            _$insertNode(_el$11, _el$12);
            _$setProp(_el$11, "onMouseUp", () => openUrl(pr.url));
            _$insert(_el$11, () => shortTitle(pr.title ?? pr.headRefName ?? pr.url, 42), _el$12);
            _$insertNode(_el$12, _el$13);
            _$insert(_el$12, () => formatAge(pr.seenAt), null);
            _$effect((_p$) => {
              var _v$3 = rowColor(props.api, pr), _v$4 = pr.state === "MERGED" ? STRIKETHROUGH : undefined, _v$5 = titleColor(props.api, pr), _v$6 = pr.state === "MERGED" ? STRIKETHROUGH : undefined, _v$7 = {
                fg: theme().textMuted
              };
              _v$3 !== _p$.e && (_p$.e = _$setProp(_el$0, "fg", _v$3, _p$.e));
              _v$4 !== _p$.t && (_p$.t = _$setProp(_el$0, "attributes", _v$4, _p$.t));
              _v$5 !== _p$.a && (_p$.a = _$setProp(_el$11, "fg", _v$5, _p$.a));
              _v$6 !== _p$.o && (_p$.o = _$setProp(_el$11, "attributes", _v$6, _p$.o));
              _v$7 !== _p$.i && (_p$.i = _$setProp(_el$12, "style", _v$7, _p$.i));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined,
              i: undefined
            });
            return _el$9;
          })()
        }), _$createComponent(Show, {
          get when() {
            return overflowLabel();
          },
          get children() {
            var _el$8 = _$createElement("text");
            _$insert(_el$8, overflowLabel);
            _$effect((_$p) => _$setProp(_el$8, "fg", theme().textMuted, _$p));
            return _el$8;
          }
        })];
      }
    }), null);
    _$effect((_p$) => {
      var _v$ = theme().text, _v$2 = theme().text;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}
var tui = async (api, options) => {
  const normalizedOptions = normalizeOptions(options);
  api.slots.register({
    order: 240,
    slots: {
      sidebar_content(_ctx, props) {
        return _$createComponent(View, {
          api,
          get sessionID() {
            return props.session_id;
          },
          options: normalizedOptions
        });
      }
    }
  });
};
var tui_default = {
  id: "pr-sidebar",
  tui
};
export {
  tui_default as default
};
