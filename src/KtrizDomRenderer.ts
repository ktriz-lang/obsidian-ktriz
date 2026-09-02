import { Platform } from "obsidian";
import { isKtrizRenderError } from "./KtrizCliRenderer";

const XLINK_NS = "http://www.w3.org/1999/xlink";

// Matches a CSS function token — e.g. the `translate(` in
// `transform="translate(10,20)"` or the `url(` in `fill="url(#x)"` — used
// below to gate presentation attributes (`fill`, `stroke`, `filter`,
// `clip-path`, `mask`, `cursor`, `transform`, …) against every CSS function
// that can trigger a real fetch, not just `url(...)`. `image-set(...)` and
// `-webkit-image-set(...)` resolve to the same kind of external request as
// `url(...)` when the browser computes styles from the attribute — a
// `cursor="image-set(\"https://evil.example/beacon.png\" 1x), auto"` fires
// exactly like `filter="url(https://evil.example/f.svg#f)"` does, without
// ever containing the substring `url(`. A blocklist keyed on that one
// function name (or any other single name) only ever covers what's already
// been found — the CSS image-function surface is open-ended (`src()`,
// `image()`, `cross-fade()`, and whatever the spec adds next). So the gate
// below is an allowlist instead: an attribute value that contains ANY CSS
// function token is kept only if every function name in it is one the kTRIZ
// renderers actually emit, with `url(...)` additionally required to be a
// same-document fragment reference (`url(#id)`). Anything else — an
// unlisted function name, or a non-fragment `url(...)` — drops the whole
// attribute, the same "never load-bearing for presentation, so drop rather
// than half-parse" stance already taken for `style` and CSS-escaped values
// below.
const CSS_FUNCTION_TOKEN_RE = /([a-zA-Z-]+)\s*\(/g;
const URL_FUNCTION_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const ALLOWED_CSS_FUNCTIONS = new Set([
  "url",
  "translate",
  "translatex",
  "translatey",
  "rotate",
  "scale",
  "scalex",
  "scaley",
  "matrix",
  "skewx",
  "skewy",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
]);

/**
 * `true` when `value` is safe to keep as-is: either it contains no CSS
 * function token at all (nothing for this gate to check), or every function
 * token in it names an allowlisted function and every `url(...)` among them
 * is a same-document fragment reference. `false` means the caller should
 * drop the whole attribute — never partially rewritten, see the module doc
 * comment above.
 */
function attributeValueUsesOnlyAllowedCssFunctions(value: string): boolean {
  CSS_FUNCTION_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let sawFunction = false;
  while ((match = CSS_FUNCTION_TOKEN_RE.exec(value)) !== null) {
    sawFunction = true;
    if (!ALLOWED_CSS_FUNCTIONS.has(match[1].toLowerCase())) return false;
  }
  if (!sawFunction) return true;
  URL_FUNCTION_RE.lastIndex = 0;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = URL_FUNCTION_RE.exec(value)) !== null) {
    if (!urlMatch[2].trim().startsWith("#")) return false;
  }
  return true;
}

/**
 * Inject a parsed SVG element into a container element.
 *
 * Uses the DOMParser pipeline (image/svg+xml) rather than innerHTML
 * injection, and strips `<script>`/`<foreignObject>`/`<style>` and every
 * SMIL animation element (`<animate>`, `<animateTransform>`,
 * `<animateMotion>`, `<set>`, `<discard>`) as defence-in-depth — the SVG
 * text comes from arbitrary user Kotlin script output, not just from the
 * kTRIZ renderers. The SMIL elements are removed alongside `<script>`
 * because they are themselves a script-free way to re-apply an attribute
 * the loop below strips: e.g. `<image href="#x"><set attributeName="href"
 * to="https://evil.example/beacon.png" begin="0s"/></image>` sets `href`
 * back to the blocked external URL purely through animation timing, no
 * `<script>` involved, firing the request as soon as the diagram is in the
 * reading view. `<style>` is removed outright rather than sanitised in
 * place: parsing full CSS correctly (including `@import` and `url(...)`
 * buried in nested selectors) is its own project, and a stylesheet is never
 * load-bearing for a kTRIZ-generated diagram's presentation. Removes static
 * width/height attributes so the SVG scales to container width via CSS.
 *
 * Throws if the SVG string is unparseable.
 */
export function injectSvg(svg: string, container: HTMLElement): void {
  const parser = new DOMParser();
  const svgDoc = parser.parseFromString(svg, "image/svg+xml");
  const parserError = svgDoc.querySelector("parsererror");
  if (parserError) {
    throw new Error(
      `Invalid SVG returned by renderer: ${parserError.textContent ?? "parse error"}`
    );
  }
  svgDoc
    .querySelectorAll("script, foreignObject, style, animate, animateTransform, animateMotion, set, discard")
    .forEach((n) => n.remove());
  // Defence-in-depth beyond the element removal above: strip every
  // event-handler attribute, any non-fragment external href/xlink:href, the
  // `style` attribute outright, and — via the CSS-function allowlist gate,
  // see `attributeValueUsesOnlyAllowedCssFunctions` above — any (non-style)
  // attribute value that invokes a CSS function outside the small positive
  // list, including a non-fragment `url(...)` — since this SVG text is the
  // stdout of an arbitrary user script rather than strictly the output of
  // the kTRIZ renderers.
  svgDoc.querySelectorAll("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
        continue;
      }
      // `style` is removed wholesale, same rationale as the `<style>`
      // element above: correctly parsing CSS values — including escape
      // sequences like `\75 rl(` for `url(`, which pass straight through
      // both the substring check and the regex below in cleartext form —
      // is its own project, and a `style` attribute is never load-bearing
      // for a kTRIZ-generated diagram's presentation.
      if (name === "style") {
        node.removeAttribute(attr.name);
        continue;
      }
      // Namespace-aware, not a literal "xlink:href" name match: the
      // xlink namespace prefix is attacker-controlled (the SVG's own
      // xmlns:xlink="…1999/xlink" declaration picks the prefix), so an
      // attribute bound to that namespace under any other prefix — or
      // the unprefixed SVG2 "href" — must be caught the same way.
      const isHrefAttr =
        attr.localName.toLowerCase() === "href" &&
        (attr.namespaceURI === null || attr.namespaceURI === XLINK_NS);
      if (isHrefAttr && !attr.value.trim().startsWith("#")) {
        if (attr.namespaceURI !== null) {
          node.removeAttributeNS(attr.namespaceURI, attr.localName);
        } else {
          node.removeAttribute(attr.name);
        }
        continue;
      }
      // CSS escape sequences (`\75 rl(` for `url(`, the 6-hex-digit form
      // `\000075 rl(`, and every other valid CSS escape spelling of any
      // function name) pass straight through the allowlist gate below in
      // cleartext form — a browser's CSS tokenizer resolves the escape and
      // still opens the real function when it computes styles from the
      // attribute, so `fill="\75 rl(https://evil.example/beacon.png)"`
      // fires the exact external request the allowlist gate exists to
      // block. No attribute value produced by the kTRIZ renderers, or by
      // any legitimate SVG, has a real reason to contain a backslash, so —
      // same rationale as the wholesale `style` removal above — the whole
      // attribute is dropped outright rather than attempting to
      // CSS-unescape it (which would mean reimplementing a CSS tokenizer
      // just to sanitise a value that was never load-bearing for
      // presentation).
      if (attr.value.includes("\\")) {
        if (attr.namespaceURI !== null) {
          node.removeAttributeNS(attr.namespaceURI, attr.localName);
        } else {
          node.removeAttribute(attr.name);
        }
        continue;
      }
      // Allowlist gate (see the module-level doc comment above
      // `CSS_FUNCTION_TOKEN_RE`): any attribute value containing a CSS
      // function name outside the small positive list, or a non-fragment
      // `url(...)`, is dropped outright — never partially rewritten — so a
      // new CSS function this list hasn't anticipated fails closed instead
      // of leaking through unnoticed.
      if (!attributeValueUsesOnlyAllowedCssFunctions(attr.value)) {
        if (attr.namespaceURI !== null) {
          node.removeAttributeNS(attr.namespaceURI, attr.localName);
        } else {
          node.removeAttribute(attr.name);
        }
      }
    }
  });
  const svgEl = svgDoc.documentElement as unknown as SVGElement;
  container.appendChild(svgEl);
  svgEl.removeAttribute("width");
  svgEl.removeAttribute("height");
  svgEl.classList.add("ktriz-diagram-svg");
}

/** Render a `KtrizRenderError` (or any other thrown value) into `container`. */
export function renderErrorInto(container: HTMLElement, err: unknown): void {
  container.addClass("ktriz-error");
  if (isKtrizRenderError(err)) {
    container.createEl("strong", { text: err.title });
    const ul = container.createEl("ul");
    for (const line of err.lines) {
      ul.createEl("li", { text: line });
    }
    if (err.code) {
      container.createEl("code", { cls: "ktriz-error-code", text: err.code });
    }
    return;
  }
  container.createEl("strong", { text: "ktriz render error" });
  container.createEl("pre", { text: err instanceof Error ? err.message : String(err) });
}

/**
 * Build the detached clone shown in the zoom lightbox.
 *
 * Clones from the already-sanitised DOM node `injectSvg` produced — never
 * re-parses the raw SVG string — so the sanitisation in `injectSvg` is not
 * bypassable via a second parse path. Strips the inline sizing so the clone
 * scales to the modal instead of keeping the inline diagram's fixed size.
 */
export function prepareZoomClone(svgEl: SVGElement): SVGElement {
  const clone = svgEl.cloneNode(true) as SVGElement;
  clone.removeAttribute("width");
  clone.removeAttribute("height");
  clone.removeAttribute("style");
  return clone;
}

/** Default total-size cap for {@link SvgCache}, see its constructor doc. */
export const SVG_CACHE_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Bounded LRU-ish cache of rendered SVGs, keyed by a hash of the source.
 *
 * Only successes belong in here — a failed render should always be retried
 * on the next view switch, since the cause (e.g. a bad CLI path) may have
 * been fixed in the meantime. Eviction drops the oldest entry by insertion
 * order (`Map` preserves insertion order in JS), which is close enough to
 * LRU for a cache of short diagram scripts without the bookkeeping a true
 * LRU needs.
 */
export class SvgCache {
  private readonly map = new Map<string, string>();
  private bytes = 0;

  /**
   * `maxSize` caps the entry *count*; `maxBytes` caps the combined size of
   * every cached SVG string (approximated as UTF-16 code units — close
   * enough for an eviction heuristic, and it keeps this module free of a
   * hard dependency on Node's `Buffer`, which the jsdom-backed verify:dom
   * harness does not provide). Entry count alone under-constrains memory:
   * each cached string is bounded only by `CLI_MAX_BUFFER` (8 MiB), so a
   * single note with `maxSize` distinct large diagrams could otherwise hold
   * `maxSize * 8 MiB` — ~512 MiB at the plugin's default `maxSize` of 64 —
   * in memory until `onunload`/settings-save, no matter how few distinct
   * entries that is.
   */
  constructor(
    private readonly maxSize: number,
    private readonly maxBytes: number = SVG_CACHE_DEFAULT_MAX_BYTES
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  put(key: string, svg: string): void {
    const previous = this.map.get(key);
    if (previous !== undefined) {
      // Overwriting a key already present changes only *that* entry's byte
      // contribution — it must never evict a different entry, and the
      // superseded value's bytes must be subtracted before the new value's
      // are added below so it isn't double-counted.
      this.bytes -= previous.length;
    } else if (this.map.size >= this.maxSize) {
      this.evictOldest();
    }
    this.map.set(key, svg);
    this.bytes += svg.length;
    // `> 1`, not `> 0`: a single entry that alone exceeds `maxBytes` (never
    // happens with the plugin's own defaults — CLI_MAX_BUFFER caps one SVG
    // well under the default cap — but is reachable with a smaller
    // `maxBytes`) is still worth keeping rather than evicting down to an
    // always-empty cache; there is nothing smaller left to evict it in
    // favour of.
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      this.evictOldest();
    }
  }

  private evictOldest(): void {
    const oldest = this.map.keys().next().value;
    if (oldest === undefined) return;
    const oldestValue = this.map.get(oldest);
    this.map.delete(oldest);
    if (oldestValue !== undefined) this.bytes -= oldestValue.length;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

/**
 * Inject a freshly-rendered SVG and, only once that succeeds, add it to the
 * cache — used by `renderBlock`'s fresh-render path in `main.ts` (never the
 * cache-hit path, which has nothing new to cache). Order matters:
 * `injectSvg` throws on malformed SVG, and only a render that actually
 * parses belongs in the cache — see `SvgCache`'s doc comment above. Caching
 * first would poison the cache with a string that fails to parse on every
 * subsequent view switch until the block's source changes or settings are
 * saved. Pulled out of `main.ts` as a small pure function so this ordering
 * invariant is directly testable here rather than only reachable through
 * Obsidian's markdown code block processor API.
 *
 * `key` is `null` when `cacheKey` couldn't derive one (mobile, or hashing
 * failed) — nothing is cached in that case, matching `cacheKey`'s contract.
 */
export function injectAndCache(
  svg: string,
  container: HTMLElement,
  cache: SvgCache,
  key: string | null
): void {
  injectSvg(svg, container);
  if (key) cache.put(key, svg);
}

/**
 * Derive a cache key for `source`. Returns `null` on mobile (no Node
 * `crypto`) or if hashing fails for any other reason — callers treat a
 * `null` key as "don't cache this render".
 */
export function cacheKey(source: string): string | null {
  if (!Platform.isDesktopApp) return null;
  try {
    const req = eval("require") as NodeRequire;
    const crypto = req("crypto") as typeof import("crypto");
    return crypto.createHash("sha256").update(source, "utf8").digest("hex");
  } catch {
    return null;
  }
}

/**
 * Caps how many renders run concurrently. Each render spawns a JVM process;
 * five concurrent renders were measured at 725% CPU on a 4-core laptop —
 * `maxConcurrent` is the highest count that still leaves it responsive.
 * Extra calls queue in arrival order and are released one-for-one as active
 * slots free up.
 */
export class RenderSlotLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      // Wait to be woken by a finishing call below. That wake-up transfers
      // its slot to us directly (see the `finally` block) rather than
      // decrementing and letting us increment on our own next tick — so we
      // must not increment `active` again here once woken.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        // Hand the just-freed slot straight to the next waiter instead of
        // `active--` followed by the waiter's own `active++` on a later
        // microtask: that gap let a caller arriving in between see
        // `active < maxConcurrent` and slip in ahead of the queued one,
        // so two callers ended up sharing what should have been one slot
        // and `active` transiently exceeded `maxConcurrent`.
        next();
      } else {
        this.active--;
      }
    }
  }
}
