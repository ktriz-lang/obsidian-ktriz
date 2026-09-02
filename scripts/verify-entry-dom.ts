// Entry point bundled by scripts/verify-dom.mjs so that the DOM
// verification script exercises the real production code in
// src/KtrizDomRenderer.ts — not a reimplementation of it.
export {
  injectSvg,
  injectAndCache,
  renderErrorInto,
  prepareZoomClone,
  SvgCache,
  RenderSlotLimiter,
  cacheKey,
} from "../src/KtrizDomRenderer";
export { isKtrizRenderError, KtrizRenderError } from "../src/KtrizCliRenderer";
