import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import { probePageInjected, type ProbeResult } from "../../dom-actions/probe-core";
import { escapeWrapperAttribute, escapeUntrustedWrappers } from "../untrusted-wrappers";
import { isRestrictedSchemeForGrouping } from "./tabs";
import { isPdfTabAsync } from "@/lib/pdf/detect";
import { pageAtlasStore, parseOrigin, type PageAtlasState } from "./page-atlas";
import { renderPageAtlas } from "./page-atlas/render";
import { executeScriptAllFrames, type AllFramesInjectionOutcome } from "../inject-all-frames";
import { estimateTokens } from "../window-token-budget";
import { diag, kv } from "../diag";
import { extractPageTextInjected, type PageTextResult } from "../../dom-actions/page-text";

// read_page byte budgets per mode. Default is the hard cap — don't truncate
// by default; the LLM can still pass a smaller max_bytes to save tokens when
// it only needs a peek. interactive stays lower by design (it only needs the
// interactive index, not full body text).
const MODE_BUDGETS = {
  auto: { maxBytes: 500_000 },
  atlas: { maxBytes: 500_000 },
  // interactive 不再返回 HTML(只发元素索引),这个预算实际不消费——留着是因为
  // resolveHtmlBudget 按 mode 查表,且 max_bytes 仍需被 clamp 成合法值。
  interactive: { maxBytes: 200_000 },
  content: { maxBytes: 300_000 },
  full: { maxBytes: 500_000 },
  // text mode is budgeted in chars via max_chars (TEXT_MAX_CHARS_*); this
  // entry only keeps resolveHtmlBudget's per-mode lookup total.
  text: { maxBytes: 500_000 },
} as const;

/** mode="text" char budget: default + clamp range for `max_chars`. */
export const TEXT_MAX_CHARS_DEFAULT = 12_000;
export const TEXT_MAX_CHARS_MIN = 500;
export const TEXT_MAX_CHARS_MAX = 60_000;
const TEXT_INJECT_TIMEOUT_MS = 10_000;

export function resolveTextMaxChars(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return TEXT_MAX_CHARS_DEFAULT;
  return Math.max(TEXT_MAX_CHARS_MIN, Math.min(TEXT_MAX_CHARS_MAX, Math.floor(n)));
}

type ReadPageMode = keyof typeof MODE_BUDGETS;

interface ReadPageArgs {
  tabId: number;
  mode?: ReadPageMode;
  max_bytes?: number;
  max_chars?: number;
  scope?: "main" | "page";
}

function normalizeMode(mode: unknown): ReadPageMode {
  return mode === "atlas" || mode === "interactive" || mode === "content" || mode === "full" || mode === "text"
    ? mode
    : "auto";
}

function resolveHtmlBudget(mode: ReadPageMode, rawMaxBytes: unknown): number {
  const cfg = MODE_BUDGETS[mode];
  if (typeof rawMaxBytes !== "number" || !Number.isFinite(rawMaxBytes)) {
    return cfg.maxBytes;
  }
  return Math.max(1, Math.min(cfg.maxBytes, Math.floor(rawMaxBytes)));
}

function classifyUnreachable(url: string, errorOccurred?: boolean, timedOut?: boolean): string {
  // 注入永不返回的僵尸 frame（导航被打断的沙箱 frame，如 micro-app/wujie iframe
  // 模式）——元数据看起来完全健康，只能靠超时识别。
  if (timedOut) return "not-responding";
  if (url.startsWith("chrome-extension://")) return "extension-child";
  if (url === "about:blank" && !errorOccurred) return "about-blank";
  if (errorOccurred) return "frame-error";
  return "sandbox";
}

// atlas/auto mode counterpart to the snapshot path's per-frame unreachable
// blocks: list every frame that yielded no atlas result so the LLM can tell a
// child app frame is genuinely unreadable (and stop retrying) rather than
// having it vanish silently.
function renderAtlasUnreachableFrames(
  frames: chrome.webNavigation.GetAllFrameResultDetails[],
  reachableFrameIds: Set<number>,
  timedOutFrameIds: Set<number>,
): string {
  const lines = frames
    .filter((f) => !reachableFrameIds.has(f.frameId))
    .sort((a, b) => a.frameId - b.frameId)
    .map((f) => {
      const reason = classifyUnreachable(f.url, f.errorOccurred, timedOutFrameIds.has(f.frameId));
      return `  frame_id="${f.frameId}" url="${escapeWrapperAttribute(f.url)}" unreachable="true" reason="${reason}"`;
    });
  if (lines.length === 0) return "";
  return ["<frame_map>", ...lines, "</frame_map>"].join("\n");
}

function attr(name: string, value: string | number | boolean): string {
  return `${name}="${escapeWrapperAttribute(String(value))}"`;
}

function elementText(value: string): string {
  return escapeWrapperAttribute(escapeUntrustedWrappers(value));
}

/**
 * `Current URL` / `Page title` lines that head every read_page observation,
 * so the model can check which page it is reading. The title is page text:
 * wrapper tags in it are escaped. When the tab's URL and the document's URL
 * disagree the page is mid-navigation — say so instead of letting the model
 * trust a page that is about to be replaced.
 */
export function pageHeaderLines(info: { tabId?: number; url: string; title: string; tabUrl: string }): string[] {
  const lines = [
    ...(info.tabId !== undefined ? [`Tab: ${info.tabId}`] : []),
    `Current URL: ${info.url}`,
    `Page title: ${escapeUntrustedWrappers(info.title)}`,
  ];
  if (info.tabUrl && info.url && info.tabUrl !== info.url) {
    lines.push(
      `Note: the browser reports ${info.tabUrl} but the document is still ${info.url} — ` +
        "the page is probably mid-navigation; call read_page again in a moment.",
    );
  }
  return lines;
}

/**
 * mode="text": readable text of the top frame only. Sub-frames are not read —
 * the observation says so when the page has any, so the model can fall back
 * to content/atlas for iframe-hosted content.
 */
async function readPageText(
  tabId: number,
  tab: chrome.tabs.Tab,
  maxChars: number,
  scope: "main" | "page",
): Promise<ActionResult> {
  let data: PageTextResult | undefined;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), TEXT_INJECT_TIMEOUT_MS);
    });
    const injected = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: extractPageTextInjected,
        args: [{ maxChars, scope }],
        // Same as the atlas/snapshot fan-out: read the current DOM, never
        // wait for document_idle.
        injectImmediately: true,
      }),
      timeout,
    ]);
    clearTimeout(timer);
    if (injected === "timeout") {
      return { success: false, error: "read_page text: page did not respond; try again in a moment" };
    }
    data = injected?.[0]?.result as PageTextResult | undefined;
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
  }
  if (!data || typeof data.text !== "string") {
    return { success: false, error: "read_page text: could not read the page" };
  }

  const remaining = Math.max(0, data.totalChars - data.text.length);
  const body = data.text || "(no readable text found — the page may still be loading, or its content is in an iframe/canvas; try mode=\"interactive\" or mode=\"content\")";
  const attrs = [attr("tool", "read_page"), attr("mode", "text"), attr("tab_id", tabId)];
  if (data.root === "main") attrs.push(attr("root", "main"));
  if (data.truncated) attrs.push(attr("truncated", true));
  const lines = [
    ...pageHeaderLines({ tabId, url: data.url || tab.url || "", title: data.title ?? tab.title ?? "", tabUrl: tab.url ?? "" }),
    ``,
    `<untrusted_page_content ${attrs.join(" ")}>`,
    escapeUntrustedWrappers(body),
    "</untrusted_page_content>",
  ];
  if (data.truncated) {
    const next = Math.min(TEXT_MAX_CHARS_MAX, Math.max(maxChars * 2, maxChars + remaining));
    lines.push(
      maxChars >= TEXT_MAX_CHARS_MAX
        ? `…truncated, ${remaining} more chars not shown (max_chars is already at its ${TEXT_MAX_CHARS_MAX} limit; use search_page to find specific text).`
        : `…truncated, ${remaining} more chars not shown. To see more, call read_page again with mode="text" and max_chars=${next}.`,
    );
  }
  if (data.root === "main" && scope === "main") {
    lines.push(`(Showing the page's main content area only; pass scope="page" to include navigation and sidebars.)`);
  }
  const observation = lines.join("\n");
  diag(
    "read_page",
    kv({ mode: "text", est: estOf(observation), chars: observation.length }),
    kv({ textChars: data.text.length, totalChars: data.totalChars, truncated: data.truncated, root: data.root, maxChars }),
  );
  return { success: true, observation };
}

function wrapPageAtlasObservation(atlas: PageAtlasState, body: string, tabUrl: string): string {
  return [
    // Header mirrors the snapshot path's `Current URL / Page title` prelude so
    // elideStaleObservations has something cheap to keep before its cut point.
    // Without it a stale atlas result elides down to a bare marker — every one
    // of them byte-identical — and the LLM can no longer tell which step read
    // which page, so it re-runs read_page instead of relying on history.
    ...pageHeaderLines({ tabId: atlas.tabId, url: atlas.fingerprint.url || atlas.url, title: atlas.title, tabUrl }),
    ``,
    `<untrusted_page_content ${attr("tool", "read_page")} ${attr("mode", "atlas")} ${attr("atlas_id", atlas.atlasId)} ${attr("tab_id", atlas.tabId)}>`,
    body,
    "</untrusted_page_content>",
  ].join("\n");
}

function frameScopedId(frameId: number, id: string): string {
  return frameId === 0 ? id : `f${frameId}_${id}`;
}

function namespaceAtlasResult(data: Extract<ProbeResult, { op: "atlas" }>, frameId: number) {
  return {
    targets: data.targets.map((target) => ({
      ...target,
      id: frameScopedId(frameId, target.id),
      frameId,
      records: target.records?.map((record) => ({
        ...record,
        id: frameScopedId(frameId, record.id),
      })),
    })),
    controls: data.controls.map((control) => ({
      ...control,
      id: frameScopedId(frameId, control.id),
      frameId,
    })),
    forms: data.forms.map((form) => ({
      ...form,
      id: frameScopedId(frameId, form.id),
      frameId,
      fields: form.fields.map((field) => frameScopedId(frameId, field)),
      submitControlId: form.submitControlId ? frameScopedId(frameId, form.submitControlId) : undefined,
    })),
  };
}

type SnapshotResult = Extract<ProbeResult, { op: "snapshot" }>;

function interactivePriority(el: SnapshotResult["interactiveElements"][number]): number {
  const tag = el.tag.toLowerCase();
  const role = el.role.toLowerCase();
  if (el.contenteditable || tag === "input" || tag === "textarea" || role === "textbox") return 0;
  if (tag === "select" || role === "combobox" || role === "listbox") return 1;
  if (tag === "button" || role === "button") return 2;
  if (tag === "a" || role === "link") return 3;
  if (role || el.type || el.placeholder || el.label || el.name) return 4;
  return 5;
}

function renderInteractiveIndex(
  mode: ReadPageMode,
  frames: Array<{ frameId: number; crossOrigin: boolean; elements: SnapshotResult["interactiveElements"] }>,
): string {
  const all = frames.flatMap((f, frameOrder) =>
    f.elements.map((el, elementOrder) => ({
      frameId: f.frameId,
      crossOrigin: f.crossOrigin,
      el,
      order: frameOrder * 1_000_000 + elementOrder,
    })),
  );
  const selected = [...all].sort(
    (a, b) => interactivePriority(a.el) - interactivePriority(b.el) || a.order - b.order,
  );

  const lines = selected.slice(0, 300).map(({ frameId, crossOrigin, el }) => {
    const attrs = [
      attr("frame_id", frameId),
      attr("pie_idx", el.pieIdx),
      attr("tag", el.tag),
      attr("role", el.role),
    ];
    if (crossOrigin) attrs.push(attr("cross_origin", true));
    if (el.name) attrs.push(attr("name", el.name));
    if (el.placeholder) attrs.push(attr("placeholder", el.placeholder));
    if (el.label) attrs.push(attr("label", el.label));
    if (el.section) attrs.push(attr("section", el.section));
    if (el.type) attrs.push(attr("type", el.type));
    if (el.contenteditable) attrs.push(attr("contenteditable", true));
    if (el.disabled) attrs.push(attr("disabled", true));
    if (el.checked) attrs.push(attr("checked", true));
    if (el.selected) attrs.push(attr("selected", true));
    if (el.hasPopup) attrs.push(attr("haspopup", el.hasPopup));
    if (el.ariaExpanded) attrs.push(attr("expanded", el.ariaExpanded));
    const text = el.text ? elementText(el.text) : "";
    return `  <interactive_element ${attrs.join(" ")}>${text}</interactive_element>`;
  });

  const header = [attr("mode", mode), attr("total", all.length)];
  if (all.length > lines.length) header.push(attr("truncated", true));
  return `<interactive_index ${header.join(" ")}>\n${lines.join("\n")}\n</interactive_index>`;
}

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

// ---------------------------------------------------------------------------
// read_page 成本诊断。回答「这次返回的 token 花在哪一段」——loop.ts 的 [ctx]
// 只能看到轮级总量,定位不到是 controls 还是正文在膨胀。
//
// 分段按渲染产物的字面块切,不改 render.ts:切片顺序要求先有基线,再动渲染。
// est 复用 estimateTokens(与 [ctx] 同一把尺子,便于两条日志直接相加对照)——
// 它已知系统性低估 40-47%,但基线和对照用同一把尺子,相对变化仍然可信。
// ---------------------------------------------------------------------------

/** 一段文本的估算 token 数,口径与 loop.ts 的 [ctx] 一致。 */
function estOf(text: string): number {
  return estimateTokens([{ role: "user", content: text }]);
}

/** `open` 到 `close`(含)之间的子串;任一缺失则空串。 */
function blockOf(body: string, open: string, close: string): string {
  const start = body.indexOf(open);
  if (start === -1) return "";
  const end = body.indexOf(close, start);
  return end === -1 ? "" : body.slice(start, end + close.length);
}

/** 所有以 `prefix` 开头(忽略缩进)的行的字符数合计。 */
function lineChars(body: string, prefix: string): number {
  let total = 0;
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith(prefix)) total += line.length + 1;
  }
  return total;
}



function sliceUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let result = "";
  for (const ch of value) {
    const byteLength = utf8ByteLength(ch);
    if (used + byteLength > maxBytes) break;
    result += ch;
    used += byteLength;
  }
  return result;
}

export const readPageTool: Tool = {
  name: "read_page",
  description:
    "Inspect the given tab. To READ what a page says (assignments, articles, posts, lists of links), " +
    "use mode=text: clean readable text with headings, lists and links as [text](url). " +
    "Use mode=interactive before click/type/select to get current element indices. " +
    "Default/auto returns a compact Page Atlas for target discovery and structured extraction. " +
    "Do not use content/full as the first inspection step: they return raw HTML and are an expensive " +
    "fallback when text/atlas/target tools are insufficient.",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "integer", description: "Tab id to read." },
      mode: {
        type: "string",
        enum: ["auto", "atlas", "text", "interactive", "content", "full"],
        description:
          "Read mode, each returning only its own surface. text: readable page text (headings, lists, links with URLs) — use this to read content. interactive: element indices only, no body text — use this before clicking/typing. auto/atlas: compact page atlas. content: raw body HTML, no element index. full: both index and HTML (most expensive). content/full are fallbacks, not first-pass inspection modes.",
      },
      max_chars: {
        type: "integer",
        minimum: TEXT_MAX_CHARS_MIN,
        maximum: TEXT_MAX_CHARS_MAX,
        description: `mode=text only: max characters of text to return (default ${TEXT_MAX_CHARS_DEFAULT}). If the result says it was truncated, call again with a larger value.`,
      },
      scope: {
        type: "string",
        enum: ["main", "page"],
        description: "mode=text only: main (default) reads the page's main content area when it has one; page reads the whole page including navigation and sidebars.",
      },
      max_bytes: {
        type: "integer",
        minimum: 1,
        description: "Optional HTML/content byte budget hint, clamped by mode-specific hard caps.",
      },
    },
    required: ["tabId"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ReadPageArgs;
    if (typeof a.tabId !== "number") {
      return { success: false, error: "read_page requires a numeric tabId" };
    }
    const mode = normalizeMode(a.mode);
    const totalBudgetBytes = resolveHtmlBudget(mode, a.max_bytes);

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(a.tabId);
    } catch {
      return { success: false, error: "Tab not found" };
    }
    if (await isPdfTabAsync(a.tabId, tab.url)) {
      return {
        success: false,
        error:
          "pdf_tab: This tab is a PDF. Use read_pdf / search_pdf / get_pdf_outline instead.",
      };
    }
    if (!tab.url || isRestrictedSchemeForGrouping(tab.url)) {
      return { success: false, error: "restrictedUrl: cannot read restricted-scheme tabs" };
    }
    if (tab.discarded) {
      return { success: false, error: "discardedTabRequiresActivation" };
    }

    if (mode === "text") {
      return readPageText(a.tabId, tab, resolveTextMaxChars(a.max_chars), a.scope === "page" ? "page" : "main");
    }

    if (mode === "atlas" || mode === "auto") {
      // Per-frame fan-out (see inject-all-frames.ts): a zombie frame with an
      // interrupted navigation must cost only its own timeout budget instead
      // of hanging the whole read.
      let injection: AllFramesInjectionOutcome<ProbeResult>;
      try {
        injection = await executeScriptAllFrames<ProbeResult>(a.tabId, probePageInjected, [
          { op: "atlas" },
        ]);
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
      }
      const { frames, results: atlasResults, timedOutFrameIds } = injection;

      const top = frames.find((f) => f.frameId === 0);
      const topUrl = top?.url ?? tab.url ?? "";
      const topAtlasResult = atlasResults.find((r) => r.frameId === 0)?.result;
      const topFingerprint = topAtlasResult?.op === "atlas"
        ? topAtlasResult.fingerprint
        : {
            url: topUrl,
            title: tab.title ?? "",
            bodyTextLengthBucket: 0,
            interactiveCountBucket: 0,
            topSectionCount: 0,
          };

      const atlasId = `atlas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const atlas: PageAtlasState = {
        atlasId,
        tabId: a.tabId,
        url: topUrl,
        origin: parseOrigin(topUrl),
        // The document's own title (fingerprint) beats tab metadata, which can
        // lag an SPA route change.
        title: topFingerprint.title || tab.title || "",
        createdAt: Date.now(),
        fingerprint: topFingerprint,
        targets: [],
        controls: [],
        forms: [],
        controlGroups: [],
        navigation: [],
      };

      const reachableFrameIds = new Set<number>();
      for (const result of atlasResults) {
        const data = result.result;
        if (data?.op !== "atlas") continue;
        const frameId = result.frameId;
        reachableFrameIds.add(frameId);
        const scoped = namespaceAtlasResult(data, frameId);
        atlas.targets.push(...scoped.targets);
        atlas.controls.push(...scoped.controls);
        atlas.forms.push(...scoped.forms);
      }

      pageAtlasStore.save(atlas);
      // Surface frames that returned no atlas result (injection failed / blocked
      // by CSP / sandbox iframe / still navigating) so the LLM knows content is
      // missing instead of silently re-running read_page forever.
      const unreachableBlock = renderAtlasUnreachableFrames(frames, reachableFrameIds, timedOutFrameIds);
      const rendered = renderPageAtlas(atlas);
      const atlasBody = unreachableBlock ? `${rendered}\n${unreachableBlock}` : rendered;
      const observation = wrapPageAtlasObservation(atlas, atlasBody, tab.url ?? "");

      const actionBlock = blockOf(atlasBody, "<action_surfaces>", "</action_surfaces>");
      const dataBlock = blockOf(atlasBody, "<data_surfaces>", "</data_surfaces>");
      const controlChars = lineChars(atlasBody, "<control ");
      diag(
        "read_page",
        kv({
          mode,
          est: estOf(observation),
          chars: observation.length,
          frames: frames.length,
          unreachable: frames.length - reachableFrameIds.size,
        }),
        // controls 是已知的大头(实测 484 条占单份 atlas 69% token)。
        // `shown/n` = top-K 后渲染的条数 / 页面上的总数,差值即 omitted。
        kv({
          controls: `${atlasBody.split("<control ").length - 1}/${atlas.controls.length}`,
          ctrlChars: controlChars,
          forms: atlas.forms.length,
          targets: atlas.targets.length,
          actionEst: estOf(actionBlock),
          dataEst: estOf(dataBlock),
          nextActionChars: lineChars(atlasBody, "<next_action "),
        }),
      );
      return { success: true, observation };
    }

    // See atlas path: per-frame fan-out so a never-responding frame can't
    // wedge the snapshot read.
    let snapshotInjection: AllFramesInjectionOutcome<ProbeResult>;
    try {
      snapshotInjection = await executeScriptAllFrames<ProbeResult>(a.tabId, probePageInjected, [
        { op: "snapshot" },
      ]);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
    }
    const { frames, results, timedOutFrameIds } = snapshotInjection;

    const top = frames.find((f) => f.frameId === 0);
    const topUrl = top?.url ?? tab.url ?? "";

    function rewriteIframePlaceholders(parentFrameId: number, html: string): string {
      const childFrames = frames!
        .filter((f) => f.parentFrameId === parentFrameId)
        // Assumes child frame IDs increase in DOM iframe-position order. Chrome
        // assigns frameIds sequentially on first parse — holds in practice; may
        // drift if a child navigates and gets a new frameId.
        .sort((x, y) => x.frameId - y.frameId);
      // Regex depends on probe-core.ts stripping all non-whitelisted iframe
      // attributes — only data-pie-iframe-position survives, so [^>]* is safe.
      return html.replace(
        /<iframe([^>]*)data-pie-iframe-position="(\d+)"([^>]*)>([\s\S]*?)<\/iframe>/g,
        (_match, before, pos, after, _inner) => {
          const idx = Number(pos);
          const child = childFrames[idx];
          if (!child) {
            return `<iframe${before}${after}>[内容见 frame_map]</iframe>`;
          }
          const cleanedBefore = before.replace(/\s*data-pie-iframe-position="\d+"/g, "").trimEnd();
          const cleanedAfter = after.replace(/\s*data-pie-iframe-position="\d+"/g, "").trimEnd();
          const prefix = cleanedBefore ? `${cleanedBefore} ` : "";
          return `<iframe ${prefix}data-frame-id="${child.frameId}"${cleanedAfter}>[内容见 frame_id=${child.frameId}]</iframe>`;
        },
      );
    }

    let topOrigin: string | null = null;
    try { topOrigin = new URL(topUrl).origin; } catch { topOrigin = null; }

    // 各 mode 只返回自己声明的表示面。此前无论哪个 mode 都同时发 interactive
    // index 和整页 HTML,mode 实际只改了 byte cap —— 与工具描述和 prompt 里的
    // 说法不符,LLM 即使正确选了轻模式也拿到不需要的内容。
    const wantIndex = mode === "interactive" || mode === "full";
    const wantBlocks = mode === "content" || mode === "full";

    const sortedFrames = [...frames].sort((a, b) => a.frameId - b.frameId);
    const frameMapLines: string[] = [];
    const frameInteractive: Array<{
      frameId: number;
      crossOrigin: boolean;
      elements: SnapshotResult["interactiveElements"];
    }> = [];
    const blocks: string[] = [];
    const scrollableLines: string[] = [];
    let used = 0;
    let budgetExhausted = false;

    for (const f of sortedFrames) {
      const inj = results.find((r) => r.frameId === f.frameId);
      const rawData = inj?.result;
      const data = rawData?.op === "snapshot" ? rawData : undefined;
      let origin: string | null = null;
      try { origin = new URL(f.url).origin; if (origin === "null") origin = null; } catch {}
      const crossOrigin = topOrigin !== null && origin !== null && origin !== topOrigin;

      if (!data) {
        const reason = classifyUnreachable(f.url, f.errorOccurred, timedOutFrameIds.has(f.frameId));
        frameMapLines.push(
          `  frame_id="${f.frameId}" url="${escapeWrapperAttribute(f.url)}" unreachable="true" reason="${reason}"`,
        );
        // frame_map 那行已经说明了不可达 —— 不发 content 面时不必再来一个空块。
        if (!wantBlocks) continue;
        const attrs = [
          `frame_id="${f.frameId}"`,
          `frame_url="${escapeWrapperAttribute(f.url)}"`,
          `unreachable="true"`,
          `reason="${reason}"`,
        ];
        blocks.push(`<untrusted_page_content ${attrs.join(" ")}></untrusted_page_content>`);
        continue;
      }

      const mapAttrs = [
        `frame_id="${f.frameId}"`,
        `url="${escapeWrapperAttribute(f.url)}"`,
      ];
      if (crossOrigin) mapAttrs.push(`cross_origin="true"`);
      frameMapLines.push("  " + mapAttrs.join(" "));
      frameInteractive.push({
        frameId: f.frameId,
        crossOrigin,
        elements: data.interactiveElements ?? [],
      });

      for (const hint of data.scrollableHints) {
        scrollableLines.push(
          `  - ${hint.region}${hint.pieIdx !== null ? ` at data-pie-idx=${hint.pieIdx}` : ""}: ${hint.visibleCount} visible, estimated ${hint.estimatedTotal} total (frame_id=${f.frameId})`,
        );
      }

      // mode=interactive 到此为止:index 与 frame_map 已备齐,整页 HTML 的
      // iframe 占位重写 + escape 是纯浪费(大页面上是几百 KB 的字符串处理)。
      if (!wantBlocks) continue;

      const blockAttrs: string[] = [
        `frame_id="${f.frameId}"`,
      ];
      if (crossOrigin) blockAttrs.push(`cross_origin="true"`);

      if (budgetExhausted) {
        blockAttrs.push(`unread="budget"`);
        blocks.push(`<untrusted_page_content ${blockAttrs.join(" ")}></untrusted_page_content>`);
        continue;
      }

      let body = rewriteIframePlaceholders(f.frameId, data.html);
      const remaining = totalBudgetBytes - used;
      let truncated = false;
      const bodyBytes = utf8ByteLength(body);
      if (bodyBytes > remaining) {
        // May cut mid-tag — LLM tolerates malformed HTML; truncation tradeoff
        // is documented in the spec.
        body = sliceUtf8(body, remaining);
        truncated = true;
        budgetExhausted = true;
      }
      used += utf8ByteLength(body);
      if (truncated) blockAttrs.push(`truncated="true"`);

      blocks.push(
        `<untrusted_page_content ${blockAttrs.join(" ")}>\n${escapeUntrustedWrappers(body)}\n</untrusted_page_content>`,
      );
    }

    // Header: prefer what the document itself reports — chrome.tabs metadata
    // can lag (or lead) an SPA route change, which is exactly when the model
    // needs to know which page it is looking at.
    const topSnapshot = results.find((r) => r.frameId === 0)?.result;
    const docInfo = topSnapshot?.op === "snapshot" ? topSnapshot : undefined;
    const headerLines = [
      ...pageHeaderLines({
        tabId: a.tabId,
        url: docInfo?.url || topUrl,
        title: docInfo?.title ?? tab.title ?? "",
        tabUrl: tab.url ?? "",
      }),
      ``,
      `<frame_map>`,
      ...frameMapLines,
      `</frame_map>`,
    ];

    const interactiveIndex = wantIndex ? renderInteractiveIndex(mode, frameInteractive) : "";
    const observationParts = [headerLines.join("\n")];
    if (interactiveIndex) observationParts.push(interactiveIndex);
    if (scrollableLines.length > 0) {
      observationParts.push(`<scrollable_regions>\n${scrollableLines.join("\n")}\n</scrollable_regions>`);
    }
    observationParts.push(...blocks);

    const observation = observationParts.join("\n\n");
    const blocksChars = blocks.reduce((n, b) => n + b.length, 0);
    diag(
      "read_page",
      kv({
        mode,
        est: estOf(observation),
        chars: observation.length,
        frames: frames.length,
      }),
      // 这两段是 snapshot 路径的两个返回面,各 mode 只发自己那一面(切片 3)。
      kv({
        idxEls: frameInteractive.reduce((n, f) => n + f.elements.length, 0),
        idxChars: interactiveIndex.length,
        blocks: blocks.length,
        blockChars: blocksChars,
        frameMapChars: headerLines.join("\n").length,
        budget: totalBudgetBytes,
        exhausted: budgetExhausted,
      }),
    );
    return { success: true, observation };
  },
};
