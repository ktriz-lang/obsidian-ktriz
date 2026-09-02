import { App, Modal, Plugin } from "obsidian";
import { KtrizSettings, DEFAULT_SETTINGS } from "./src/KtrizSettings";
import { KtrizSettingsTab } from "./src/KtrizSettingsTab";
import { renderViaCli } from "./src/KtrizCliRenderer";
import {
  RenderSlotLimiter,
  SvgCache,
  cacheKey,
  injectAndCache,
  injectSvg,
  prepareZoomClone,
  renderErrorInto,
} from "./src/KtrizDomRenderer";

// ── Render cache ────────────────────────────────────────────────────────────
// Keyed by a hash of the source so identical blocks re-render instantly
// (no spinner) after the first successful render.
const svgCache = new SvgCache(64);

// ── Concurrency limiter ─────────────────────────────────────────────────────
// See RenderSlotLimiter's doc comment for the measurement behind "3".
const renderSlot = new RenderSlotLimiter(3);

/**
 * Lightbox modal that displays a ktriz diagram SVG at full width.
 *
 * Opens when the user clicks on any rendered diagram. Obsidian's Modal base
 * class handles Escape-to-close and click-on-backdrop-to-close.
 */
class KtrizZoomModal extends Modal {
  private readonly svgClone: SVGElement;

  constructor(app: App, svgEl: SVGElement) {
    super(app);
    this.svgClone = prepareZoomClone(svgEl);
  }

  onOpen(): void {
    this.modalEl.addClass("ktriz-zoom-modal");
    this.contentEl.addClass("ktriz-zoom-content");
    this.contentEl.appendChild(this.svgClone);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class KtrizPlugin extends Plugin {
  settings!: KtrizSettings;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new KtrizSettingsTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor("ktriz", async (source, el) => {
      await this.renderBlock(source, el);
    });
  }

  onunload(): void {
    svgCache.clear();
  }

  private async renderBlock(source: string, el: HTMLElement): Promise<void> {
    // Not `source.trim()` here — the whole `source` string, unmodified, is
    // what gets written to the temp file the CLI compiles. Trimming it
    // would shift every 1-based line/column the CLI reports for compile
    // errors.
    if (source.trim().length === 0) return;

    const container = el.createDiv({ cls: "ktriz-diagram" });

    const key = cacheKey(source);
    const cached = key ? svgCache.get(key) : undefined;
    if (cached !== undefined) {
      try {
        injectSvg(cached, container);
        this.wireZoom(container);
      } catch (err) {
        renderErrorInto(container, err);
      }
      return;
    }

    const loading = container.createDiv({ cls: "ktriz-loading" });
    loading.createDiv({ cls: "ktriz-spinner" });
    loading.createSpan({ cls: "ktriz-loading-text", text: "Rendering diagram…" });

    try {
      const svg = await renderSlot.run(() => renderViaCli(source, this.settings.cliPath));
      loading.remove();
      // See injectAndCache's doc comment for why inject must happen before
      // (and gate) the cache write.
      injectAndCache(svg, container, svgCache, key);
      this.wireZoom(container);
    } catch (err) {
      loading.remove();
      renderErrorInto(container, err);
    }
  }

  private wireZoom(container: HTMLElement): void {
    const svgEl = container.querySelector<SVGElement>("svg");
    if (!svgEl) return;
    container.addClass("ktriz-diagram--zoomable");
    container.addEventListener("click", () => {
      new KtrizZoomModal(this.app, svgEl).open();
    });
  }

  async loadSettings(): Promise<void> {
    // `Plugin.loadData()` is declared `Promise<any>` in the Obsidian types;
    // narrowing to `Partial<KtrizSettings> | null` before the
    // `Object.assign` keeps that `any` from leaking into `this.settings`.
    const persisted = (await this.loadData()) as Partial<KtrizSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, persisted ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // The user may have just pointed cliPath at a different/newer CLI —
    // stale cached SVGs from the old renderer must not linger.
    svgCache.clear();
  }
}
