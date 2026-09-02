// Entry point bundled by scripts/verify-cli.mjs so that the verification
// script exercises the real production code in src/KtrizCliRenderer.ts —
// not a reimplementation of it.
export {
  renderViaCli,
  extractSvg,
  parseCliJson,
  isKtrizRenderError,
} from "../src/KtrizCliRenderer";
