// Verifies src/KtrizDomRenderer.ts (the DOM-facing logic main.ts wires into
// Obsidian's Plugin API) against a real DOM, via jsdom — no mocked
// DOMParser, no reimplementation of the sanitisation logic. It bundles
// scripts/verify-entry-dom.ts (which re-exports the production functions)
// with esbuild, aliasing "obsidian" to obsidian-stub.mjs, installs the
// small subset of Obsidian's HTMLElement prototype extensions the code
// relies on (see dom-polyfill.mjs), and drives the real functions through
// jsdom-backed elements.
//
// Unlike verify:cli, this does not need the ktriz CLI binary and runs
// unconditionally — it is part of `npm test` / CI.
//
// Run with: npm run verify:dom

import { JSDOM } from "jsdom";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { buildEntry } from "./build-entry.mjs";
import { installObsidianDomPolyfills } from "./dom-polyfill.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   - ${name}`);
    passed++;
  } else {
    console.error(`  FAIL - ${name}${detail !== undefined ? `: ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const { window } = dom;
  installObsidianDomPolyfills(window);
  // Only the globals the bundled production code actually touches at
  // runtime (DOMParser inside injectSvg; document to build test fixtures
  // here). Everything else stays scoped to `window` / `dom`.
  global.window = window;
  global.document = window.document;
  global.DOMParser = window.DOMParser;
  global.Node = window.Node;

  const outFile = await buildEntry(
    path.join(__dirname, "verify-entry-dom.ts"),
    path.join(os.tmpdir(), `ktriz-verify-dom-${Date.now()}.cjs`),
    __dirname
  );
  const {
    injectSvg,
    injectAndCache,
    renderErrorInto,
    prepareZoomClone,
    SvgCache,
    RenderSlotLimiter,
    cacheKey,
    isKtrizRenderError,
    KtrizRenderError,
  } = require(outFile);

  const SVG_NS = "http://www.w3.org/2000/svg";
  const div = () => window.document.createElement("div");

  console.log("injectSvg: happy path");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}" width="120" height="60"><rect width="10" height="10"/></svg>`,
      c
    );
    const svgEl = c.querySelector("svg");
    check("svg element injected", svgEl !== null);
    check("width attribute removed", svgEl && svgEl.getAttribute("width") === null);
    check("height attribute removed", svgEl && svgEl.getAttribute("height") === null);
    check(
      "ktriz-diagram-svg class added",
      svgEl && svgEl.classList.contains("ktriz-diagram-svg")
    );
  }

  console.log("injectSvg: strips <script>");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}"><script>alert(1)</script><rect width="1" height="1"/></svg>`,
      c
    );
    check("script element removed", c.querySelector("script") === null);
    check("sibling rect kept", c.querySelector("rect") !== null);
  }

  console.log("injectSvg: strips <foreignObject>");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}"><foreignObject><div>html</div></foreignObject><rect width="1" height="1"/></svg>`,
      c
    );
    check("foreignObject removed", c.querySelector("foreignObject") === null);
  }

  console.log("injectSvg: strips on* handler attributes");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}" onload="evil()"><rect onclick="evil()" width="1" height="1"/></svg>`,
      c
    );
    const svgEl = c.querySelector("svg");
    const rectEl = c.querySelector("rect");
    check("onload stripped from svg root", svgEl && svgEl.getAttribute("onload") === null);
    check("onclick stripped from child", rectEl && rectEl.getAttribute("onclick") === null);
  }

  console.log("injectSvg: strips non-fragment href, keeps fragment href");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}"><defs><marker id="m"/></defs>` +
        `<use href="#m"/>` +
        `<a href="https://evil.example/">bad</a></svg>`,
      c
    );
    const useEl = c.querySelector("use");
    const aEl = c.querySelector("a");
    check("fragment href kept on <use>", useEl && useEl.getAttribute("href") === "#m");
    check("external href stripped from <a>", aEl && aEl.getAttribute("href") === null);
  }

  console.log("injectSvg: strips non-fragment xlink:href, keeps fragment xlink:href");
  {
    const c = div();
    const XLINK_NS = "http://www.w3.org/1999/xlink";
    injectSvg(
      `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}"><defs><marker id="m2"/></defs>` +
        `<use xlink:href="#m2"/>` +
        `<image xlink:href="https://evil.example/x.png"/></svg>`,
      c
    );
    const useEl = c.querySelector("use");
    const imageEl = c.querySelector("image");
    check(
      "fragment xlink:href kept",
      useEl && useEl.getAttributeNS(XLINK_NS, "href") === "#m2"
    );
    check(
      "external xlink:href stripped",
      imageEl && imageEl.getAttributeNS(XLINK_NS, "href") === null
    );
  }

  console.log("injectSvg: strips xlink-namespaced href under a non-standard prefix");
  {
    const c = div();
    const XLINK_NS = "http://www.w3.org/1999/xlink";
    // The prefix bound to the xlink namespace is attacker-controlled (it's
    // just whatever the xmlns declaration on the root says) — sanitisation
    // must key off the namespace, not the literal string "xlink:href".
    injectSvg(
      `<svg xmlns="${SVG_NS}" xmlns:xl="${XLINK_NS}"><defs><marker id="m3"/></defs>` +
        `<use xl:href="#m3"/>` +
        `<image xl:href="https://evil.example/track.png"/></svg>`,
      c
    );
    const useEl = c.querySelector("use");
    const imageEl = c.querySelector("image");
    check(
      "fragment href kept under alternate prefix",
      useEl && useEl.getAttributeNS(XLINK_NS, "href") === "#m3"
    );
    check(
      "external href stripped under alternate prefix",
      imageEl && imageEl.getAttributeNS(XLINK_NS, "href") === null
    );
  }

  console.log("injectSvg: strips unprefixed SVG2 href the same as xlink:href");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}"><defs><marker id="m4"/></defs>` +
        `<use href="#m4"/>` +
        `<image href="https://evil.example/y.png"/></svg>`,
      c
    );
    const useEl = c.querySelector("use");
    const imageEl = c.querySelector("image");
    check("fragment href kept (SVG2, unprefixed)", useEl && useEl.getAttribute("href") === "#m4");
    check(
      "external href stripped (SVG2, unprefixed)",
      imageEl && imageEl.getAttribute("href") === null
    );
  }

  console.log("injectSvg: strips <style> elements");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}"><style>@import url("https://evil.example/x.css");</style>` +
        `<rect width="1" height="1"/></svg>`,
      c
    );
    check("style element removed", c.querySelector("style") === null);
    check("sibling rect kept", c.querySelector("rect") !== null);
  }

  console.log("injectSvg: drops non-fragment url(...) in presentation attributes, keeps fragment url(...)");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}">` +
        `<defs><filter id="okFilter"/></defs>` +
        `<rect id="bad" filter="url(https://evil.example/f.svg#f)" width="1" height="1"/>` +
        `<rect id="good" filter="url(#okFilter)" width="1" height="1"/>` +
        `</svg>`,
      c
    );
    const bad = c.querySelector("#bad");
    const good = c.querySelector("#good");
    check(
      "external url() in filter removed along with the whole attribute",
      bad && bad.getAttribute("filter") === null,
      bad && bad.getAttribute("filter")
    );
    check(
      "fragment url() in filter kept",
      good && good.getAttribute("filter") === "url(#okFilter)"
    );
  }

  console.log(
    "injectSvg: drops image-set()/-webkit-image-set() presentation attributes (CSS-function allowlist bypass)"
  );
  {
    // Round-2 fix closed the CSS-escape bypass (`\75 rl(` for `url(`) but the
    // gate it left behind was still keyed on the single substring `url(` —
    // `image-set(...)` resolves to the same kind of external fetch as
    // `url(...)` when a browser computes styles from the attribute, without
    // ever containing that substring, so it sailed straight through. The
    // allowlist gate (`attributeValueUsesOnlyAllowedCssFunctions`) closes
    // this by requiring every CSS function name in an attribute value to be
    // on a small positive list, so `image-set` — and any other CSS function
    // not on that list — is rejected regardless of spelling.
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}">` +
        `<rect id="cursorImageSet" cursor="image-set(&quot;https://evil.example/a.png&quot; 1x), auto" width="1" height="1"/>` +
        `<rect id="cursorWebkitImageSet" cursor="-webkit-image-set(url(https://evil.example/b.png) 1x)" width="1" height="1"/>` +
        `<rect id="maskImageSet" mask="image-set(&quot;https://evil.example/c.png&quot; 1x)" width="1" height="1"/>` +
        `</svg>`,
      c
    );
    const cursorImageSet = c.querySelector("#cursorImageSet");
    const cursorWebkitImageSet = c.querySelector("#cursorWebkitImageSet");
    const maskImageSet = c.querySelector("#maskImageSet");
    check(
      "cursor image-set() removed along with the whole attribute",
      cursorImageSet && cursorImageSet.getAttribute("cursor") === null,
      cursorImageSet && cursorImageSet.getAttribute("cursor")
    );
    check(
      "cursor -webkit-image-set() removed along with the whole attribute",
      cursorWebkitImageSet && cursorWebkitImageSet.getAttribute("cursor") === null,
      cursorWebkitImageSet && cursorWebkitImageSet.getAttribute("cursor")
    );
    check(
      "mask image-set() removed along with the whole attribute",
      maskImageSet && maskImageSet.getAttribute("mask") === null,
      maskImageSet && maskImageSet.getAttribute("mask")
    );
  }

  console.log(
    "injectSvg: allowlisted CSS functions (transform, fragment url()) survive untouched"
  );
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}">` +
        `<defs><filter id="blur"/></defs>` +
        `<rect id="transformed" transform="translate(10,20) rotate(45)" width="1" height="1"/>` +
        `<rect id="filtered" filter="url(#blur)" width="1" height="1"/>` +
        `</svg>`,
      c
    );
    const transformed = c.querySelector("#transformed");
    const filtered = c.querySelector("#filtered");
    check(
      "transform=\"translate(10,20) rotate(45)\" kept unchanged",
      transformed && transformed.getAttribute("transform") === "translate(10,20) rotate(45)",
      transformed && transformed.getAttribute("transform")
    );
    check(
      "filter=\"url(#blur)\" kept unchanged",
      filtered && filtered.getAttribute("filter") === "url(#blur)",
      filtered && filtered.getAttribute("filter")
    );
  }

  console.log("injectSvg: strips presentation attributes hidden behind a CSS escape sequence");
  {
    // Same bypass as the style-attribute escape case below, but against the
    // url(...) substring/regex gate that guards presentation attributes
    // directly (fill, cursor, clip-path, mask, …): a CSS escape sequence
    // (`\75 rl(` for `url(`, or the 6-hex-digit form `\000075 rl(`) never
    // matches `includes("url(")` or URL_FUNCTION_RE in cleartext form, but a
    // browser's CSS tokenizer resolves it back to a `url(...)` function when
    // computing styles from the attribute — so the whole attribute must be
    // dropped whenever it contains a backslash, not just sanitised via the
    // regex.
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}">` +
        `<rect id="fillEscaped" fill="\\75 rl(https://evil.example/x.png)" width="1" height="1"/>` +
        `<rect id="cursorEscaped" cursor="\\75 rl(https://evil.example/y.png), auto" width="1" height="1"/>` +
        `<rect id="fillEscapedLong" fill="\\000075 rl(https://evil.example/z.png)" width="1" height="1"/>` +
        `</svg>`,
      c
    );
    const fillEl = c.querySelector("#fillEscaped");
    const cursorEl = c.querySelector("#cursorEscaped");
    const fillLongEl = c.querySelector("#fillEscapedLong");
    check(
      "escaped url() in fill removed along with the whole attribute",
      fillEl && fillEl.getAttribute("fill") === null,
      fillEl && fillEl.getAttribute("fill")
    );
    check(
      "escaped url() in cursor removed along with the whole attribute",
      cursorEl && cursorEl.getAttribute("cursor") === null,
      cursorEl && cursorEl.getAttribute("cursor")
    );
    check(
      "6-hex-digit escaped url() in fill removed along with the whole attribute",
      fillLongEl && fillLongEl.getAttribute("fill") === null,
      fillLongEl && fillLongEl.getAttribute("fill")
    );
  }

  console.log("injectSvg: strips the style attribute outright (not just sanitised)");
  {
    // The style attribute is removed wholesale rather than sanitised via
    // the url(...) regex — a substring/regex check on raw CSS text is
    // bypassable with CSS escape sequences (e.g. `\75 rl(` for `url(`),
    // which a real CSS parser resolves but which never matches
    // `includes("url(")` or URL_FUNCTION_RE in cleartext form.
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}"><rect style="fill:url(https://evil.example/p.png)" width="1" height="1"/></svg>`,
      c
    );
    const rectEl = c.querySelector("rect");
    check(
      "style attribute removed entirely",
      rectEl && rectEl.getAttribute("style") === null,
      rectEl && rectEl.getAttribute("style")
    );
  }

  console.log("injectSvg: strips style attribute hidden behind a CSS escape sequence");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}"><rect style="fill:\\75 rl(https://evil.example/x.png)" width="1" height="1"/></svg>`,
      c
    );
    const rectEl = c.querySelector("rect");
    check(
      "escaped url() in style attribute removed along with the whole attribute",
      rectEl && rectEl.getAttribute("style") === null,
      rectEl && rectEl.getAttribute("style")
    );
  }

  console.log("injectSvg: strips SMIL animation elements that could re-apply a stripped href");
  {
    // <set>/<animate>/… are a script-free way to re-apply an attribute the
    // href-sanitisation loop just stripped, purely via animation timing —
    // no <script> element involved. Removing them alongside <script> closes
    // that bypass.
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}"><image href="#x"><set attributeName="href" to="https://evil.example/beacon.png" begin="0s"/></image></svg>`,
      c
    );
    check("<set> element removed", c.querySelector("set") === null);
    const imageEl = c.querySelector("image");
    check("image href left as the safe fragment value", imageEl && imageEl.getAttribute("href") === "#x");
  }

  console.log("injectSvg: strips <animate>, <animateTransform>, <animateMotion>, <discard>");
  {
    const c = div();
    injectSvg(
      `<svg xmlns="${SVG_NS}">` +
        `<rect width="1" height="1"><animate attributeName="fill" values="red" /></rect>` +
        `<rect width="1" height="1"><animateTransform attributeName="transform" type="rotate" values="0" /></rect>` +
        `<rect width="1" height="1"><animateMotion path="M0,0" /></rect>` +
        `<discard begin="0s"/>` +
        `</svg>`,
      c
    );
    check("animate removed", c.querySelector("animate") === null);
    check("animateTransform removed", c.querySelector("animateTransform") === null);
    check("animateMotion removed", c.querySelector("animateMotion") === null);
    check("discard removed", c.querySelector("discard") === null);
    check("three sibling rects survive", c.querySelectorAll("rect").length === 3);
  }

  console.log("injectSvg: throws on unparseable SVG");
  {
    const c = div();
    let threw = false;
    let message = "";
    try {
      injectSvg(`<svg xmlns="${SVG_NS}"><rect></svg>`, c); // unclosed <rect>, invalid XML
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    check("throws on malformed SVG", threw);
    check("error message mentions invalid SVG", message.includes("Invalid SVG"), message);
  }

  console.log("renderErrorInto: KtrizRenderError");
  {
    const c = div();
    const err = new KtrizRenderError("My Title", ["line one", "line two"], "KTRIZ-X-1");
    renderErrorInto(c, err);
    check("ktriz-error class added", c.classList.contains("ktriz-error"));
    check("title rendered", c.querySelector("strong")?.textContent === "My Title");
    const items = Array.from(c.querySelectorAll("li")).map((li) => li.textContent);
    check("both lines rendered as <li>", items.length === 2 && items[0] === "line one" && items[1] === "line two", JSON.stringify(items));
    check("code element carries err.code", c.querySelector("code")?.textContent === "KTRIZ-X-1");
  }

  console.log("renderErrorInto: generic Error (no code)");
  {
    const c = div();
    const err = new KtrizRenderError("No code here", ["one line"]);
    renderErrorInto(c, err);
    check("no code element when err.code is absent", c.querySelector("code") === null);
  }

  console.log("renderErrorInto: non-KtrizRenderError value");
  {
    const c = div();
    renderErrorInto(c, new Error("boom"));
    check("generic title used", c.querySelector("strong")?.textContent === "ktriz render error");
    check("message rendered as <pre>", c.querySelector("pre")?.textContent === "boom");
  }

  console.log("renderErrorInto: thrown non-Error value");
  {
    const c = div();
    renderErrorInto(c, "just a string");
    check(
      "non-Error value stringified into <pre>",
      c.querySelector("pre")?.textContent === "just a string"
    );
  }

  console.log("isKtrizRenderError: type guard sanity");
  {
    check("true for KtrizRenderError", isKtrizRenderError(new KtrizRenderError("t", [])));
    check("false for plain Error", !isKtrizRenderError(new Error("x")));
    check("false for a plain object", !isKtrizRenderError({ title: "t" }));
  }

  console.log("prepareZoomClone: sanitised, independent clone");
  {
    const original = window.document.createElementNS(SVG_NS, "svg");
    original.setAttribute("width", "100");
    original.setAttribute("height", "50");
    original.setAttribute("style", "max-width:100%");
    original.classList.add("ktriz-diagram-svg");

    const clone = prepareZoomClone(original);
    check("clone is a different node than the original", clone !== original);
    check("width stripped on clone", clone.getAttribute("width") === null);
    check("height stripped on clone", clone.getAttribute("height") === null);
    check("style stripped on clone", clone.getAttribute("style") === null);
    check("class preserved on clone", clone.classList.contains("ktriz-diagram-svg"));

    original.setAttribute("data-after-clone", "1");
    check(
      "mutating original after cloning does not affect the clone",
      clone.getAttribute("data-after-clone") === null
    );
  }

  console.log("SvgCache: get/put and bounded eviction");
  {
    const cache = new SvgCache(3);
    check("empty cache size is 0", cache.size === 0);
    cache.put("a", "svg-a");
    cache.put("b", "svg-b");
    cache.put("c", "svg-c");
    check("size after 3 puts is 3", cache.size === 3);
    check("get returns what was put", cache.get("b") === "svg-b");

    cache.put("d", "svg-d"); // over capacity — oldest ("a") must be evicted
    check("size stays capped at maxSize", cache.size === 3, cache.size);
    check("oldest entry evicted", cache.get("a") === undefined);
    check("newest entry present", cache.get("d") === "svg-d");
    check("middle entry survives", cache.get("b") === "svg-b");

    cache.clear();
    check("clear() empties the cache", cache.size === 0);
    check("cleared entries are gone", cache.get("d") === undefined);
  }

  console.log("SvgCache: overwriting an existing key never evicts a different entry");
  {
    const cache = new SvgCache(3);
    cache.put("a", "svg-a");
    cache.put("b", "svg-b");
    cache.put("c", "svg-c");
    cache.put("b", "svg-b-updated"); // key already present, cache already at maxSize
    check("size stays at maxSize, not shrunk", cache.size === 3, cache.size);
    check("overwritten key holds the new value", cache.get("b") === "svg-b-updated");
    check("untouched entry 'a' survives", cache.get("a") === "svg-a");
    check("untouched entry 'c' survives", cache.get("c") === "svg-c");
  }

  console.log("SvgCache: total byte budget evicts by size even under the entry-count cap");
  {
    // maxSize is generous (10 entries) so only the byte cap can be the
    // thing that trims this cache — a large enough single note's worth of
    // diagrams must not be allowed to grow the cache unboundedly just
    // because it stays under the entry-count limit.
    const cache = new SvgCache(10, 100 /* bytes */);
    cache.put("a", "x".repeat(40));
    cache.put("b", "x".repeat(40));
    check("two 40-byte entries fit under the 100-byte cap", cache.size === 2, cache.size);
    cache.put("c", "x".repeat(40)); // pushes total to 120 > 100
    check(
      "adding a third entry evicts the oldest to stay under the byte cap",
      cache.size === 2 && cache.get("a") === undefined && cache.get("b") !== undefined && cache.get("c") !== undefined,
      `size=${cache.size} a=${cache.get("a")} b=${cache.get("b") !== undefined} c=${cache.get("c") !== undefined}`
    );
  }

  console.log("SvgCache: a single entry larger than the byte budget still gets cached alone");
  {
    const cache = new SvgCache(10, 50 /* bytes */);
    cache.put("huge", "x".repeat(80));
    check(
      "oversized single entry is kept (nothing smaller to evict) rather than looping forever",
      cache.size === 1 && cache.get("huge") === "x".repeat(80)
    );
  }

  console.log("injectAndCache: caches only after a successful inject");
  {
    const cache = new SvgCache(8);
    const c = div();
    injectAndCache(
      `<svg xmlns="${SVG_NS}" width="10" height="10"><rect width="1" height="1"/></svg>`,
      c,
      cache,
      "goodkey"
    );
    check("svg injected into container", c.querySelector("svg") !== null);
    check("cache populated after a successful inject", cache.get("goodkey") !== undefined);
  }

  console.log(
    "injectAndCache: a malformed SVG throws and never reaches the cache (renderBlock ordering)"
  );
  {
    // Guards the inject-before-cache ordering renderBlock relies on: caching
    // first would poison the cache with a string that fails to parse on
    // every subsequent view switch, until the source changes or settings
    // are saved (see the doc comment on injectAndCache/SvgCache).
    const cache = new SvgCache(8);
    const c = div();
    let threw = false;
    try {
      injectAndCache(`<svg xmlns="${SVG_NS}"><rect></svg>`, c, cache, "badkey"); // unclosed <rect>
    } catch {
      threw = true;
    }
    check("injectAndCache propagates the parse failure", threw);
    check("cache stays empty after a failed inject", cache.get("badkey") === undefined);
    check("cache size is still 0", cache.size === 0, cache.size);
  }

  console.log("injectAndCache: null key (e.g. mobile/hashing-failed) never writes the cache");
  {
    const cache = new SvgCache(8);
    const c = div();
    injectAndCache(
      `<svg xmlns="${SVG_NS}" width="10" height="10"><rect width="1" height="1"/></svg>`,
      c,
      cache,
      null
    );
    check("svg still injected with a null key", c.querySelector("svg") !== null);
    check("cache stays empty with a null key", cache.size === 0, cache.size);
  }

  console.log("cacheKey: deterministic sha256 hex digest");
  {
    const k1 = cacheKey("println(1)");
    const k2 = cacheKey("println(1)");
    const k3 = cacheKey("println(2)");
    check("returns a 64-char hex string", typeof k1 === "string" && /^[0-9a-f]{64}$/.test(k1), k1);
    check("same input -> same key", k1 === k2);
    check("different input -> different key", k1 !== k3);
  }

  console.log("RenderSlotLimiter: caps concurrency and drains the queue");
  {
    const limiter = new RenderSlotLimiter(2);
    const pendingResolvers = [];
    let maxActive = 0;
    const finished = [];

    const tasks = [1, 2, 3, 4].map((i) =>
      limiter.run(
        () =>
          new Promise((resolve) => {
            maxActive = Math.max(maxActive, limiter.activeCount);
            pendingResolvers.push(() => {
              finished.push(i);
              resolve(i);
            });
          })
      )
    );

    // Resolve whatever is currently running, give the freed slot(s) a tick
    // to admit the next queued task(s), repeat until all four have run.
    for (let iter = 0; iter < 20 && finished.length < 4; iter++) {
      while (pendingResolvers.length > 0) pendingResolvers.shift()();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(tasks);

    check("all four calls eventually ran", finished.length === 4, JSON.stringify(finished));
    check(
      "concurrency never exceeded the configured max (2)",
      maxActive > 0 && maxActive <= 2,
      `maxActive=${maxActive}`
    );
    check("no active slots left after completion", limiter.activeCount === 0, limiter.activeCount);
    check("no queued callers left after completion", limiter.queuedCount === 0, limiter.queuedCount);
  }

  console.log(
    "RenderSlotLimiter: a newcomer arriving as a slot is freed does not over-admit (regression)"
  );
  {
    // Reproduces the race: a queued waiter is woken by a finishing call,
    // but before the fix the freed slot was released (`active--`) and only
    // re-claimed by the woken waiter on a later microtask tick. A brand
    // new caller arriving in that gap could see `active < maxConcurrent`
    // and admit itself immediately, so both it and the woken waiter ended
    // up counted, one slot over the limit.
    //
    // The gap is a *microtask* gap, not the synchronous turn immediately
    // after calling the finishing task's resolver: `resolvers.shift()()`
    // only calls `resolve()` on the promise `fn()` returned — the `finally`
    // block in `run()` (where `active--` happens) is itself gated behind
    // `await fn()`, so it does not run until a later microtask. A newcomer
    // created in the *same* synchronous turn as the resolve() call never
    // observes the buggy intermediate state at all, pre-fix or post-fix,
    // because `active` has not moved yet — a first version of this test
    // made exactly that mistake and stayed green against the reverted,
    // buggy `run()` body. `runRace(delay)` below instead lets `delay`
    // microtasks elapse (via chained `Promise.resolve()` awaits, not
    // `setTimeout`, to stay within the same microtask-queue race the real
    // bug lived in) before creating the newcomer, and the test sweeps
    // several delays so it does not depend on guessing the exact tick the
    // window opens on.
    async function runRace(delay) {
      const limiter = new RenderSlotLimiter(3);
      // `resolvers` holds one entry per fn() *invocation* (pushed as soon
      // as a call is admitted and its executor runs) — used to assert "3
      // admitted immediately" below. `finished` only grows once a resolver
      // has actually been invoked, so — mirroring the drain loop above —
      // the loop exit condition must watch `finished`, not admission
      // count: a task admitted mid-wait still has an unflushed resolver
      // sitting in `resolvers` the moment admission count alone reaches 6,
      // and exiting the loop right there would leave that resolver
      // uncalled and `Promise.all` below waiting forever.
      let maxActive = 0;
      const resolvers = [];
      const finished = [];

      const makeTask = (id) =>
        limiter.run(
          () =>
            new Promise((resolve) => {
              maxActive = Math.max(maxActive, limiter.activeCount);
              resolvers.push(() => {
                finished.push(id);
                resolve(id);
              });
            })
        );

      const initial = [1, 2, 3, 4, 5].map(makeTask);
      const admittedImmediately = resolvers.length === 3 && limiter.queuedCount === 2;

      resolvers.shift()(); // this closure pushes onto `finished` itself
      for (let i = 0; i < delay; i++) await Promise.resolve();
      const newcomer = makeTask("newcomer");
      const newcomerQueued = limiter.queuedCount >= 1;

      for (let iter = 0; iter < 30 && finished.length < 6; iter++) {
        while (resolvers.length > 0) resolvers.shift()();
        await new Promise((r) => setTimeout(r, 5));
      }
      await Promise.all([...initial, newcomer]);

      return {
        admittedImmediately,
        newcomerQueued,
        maxActive,
        finishedCount: finished.length,
        finishedAll: JSON.stringify(finished),
        activeAfter: limiter.activeCount,
        queuedAfter: limiter.queuedCount,
      };
    }

    // Sweep several microtask delays rather than pinning the test to
    // whichever single tick count happened to reproduce the bug on one
    // run — the exact depth of the promise-chain gap is an implementation
    // detail of `run()`'s await structure, not a contract this test should
    // hardcode.
    for (let delay = 0; delay <= 3; delay++) {
      const r = await runRace(delay);
      check(
        `delay=${delay}: three tasks admitted immediately, two queued`,
        r.admittedImmediately
      );
      check(`delay=${delay}: newcomer did not slip in ahead unqueued`, r.newcomerQueued);
      check(`delay=${delay}: all six calls eventually ran`, r.finishedCount === 6, r.finishedAll);
      check(
        `delay=${delay}: concurrency never exceeded the configured max (3)`,
        r.maxActive > 0 && r.maxActive <= 3,
        `maxActive=${r.maxActive}`
      );
      check(`delay=${delay}: no active slots left after completion`, r.activeAfter === 0, r.activeAfter);
      check(`delay=${delay}: no queued callers left after completion`, r.queuedAfter === 0, r.queuedAfter);
    }
  }

  try {
    fs.unlinkSync(outFile);
  } catch {
    // best effort
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
