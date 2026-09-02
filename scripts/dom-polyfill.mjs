// Polyfills for the small subset of Obsidian's HTMLElement prototype
// extensions that src/KtrizDomRenderer.ts and main.ts rely on
// (createDiv/createEl/createSpan/addClass/removeClass/empty). Obsidian adds
// these to every HTMLElement at runtime inside the app; jsdom (used by
// scripts/verify-dom.mjs to exercise that code outside the app) has no idea
// they exist, so this installs faithful-enough equivalents on top of a
// jsdom window before the bundled entry point runs.
//
// Behaviour matches the documented Obsidian API
// (https://docs.obsidian.md/Reference/TypeScript+API/HTMLElement):
// createEl(tag, opts?) creates, configures and appends a child element;
// createDiv/createSpan are createEl("div"/"span", opts) shorthands;
// addClass/removeClass wrap classList; empty() removes all children.
export function installObsidianDomPolyfills(window) {
  const proto = window.HTMLElement.prototype;

  proto.createEl = function (tag, opts) {
    const el = this.ownerDocument.createElement(tag);
    if (opts) {
      if (opts.cls) {
        const classes = Array.isArray(opts.cls) ? opts.cls : [opts.cls];
        el.className = classes.join(" ");
      }
      if (opts.text !== undefined) el.textContent = opts.text;
      if (opts.attr) {
        for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
      }
    }
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (opts) {
    return this.createEl("div", opts);
  };
  proto.createSpan = function (opts) {
    return this.createEl("span", opts);
  };
  proto.addClass = function (cls) {
    this.classList.add(cls);
  };
  proto.removeClass = function (cls) {
    this.classList.remove(cls);
  };
  proto.empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
}
