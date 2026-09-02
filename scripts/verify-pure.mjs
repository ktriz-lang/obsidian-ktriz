// Verifies the pure, CLI-process-independent logic in
// src/KtrizCliRenderer.ts — JSON parsing, SVG extraction, stderr filtering
// and error formatting — against synthetic input. No child process is
// spawned and no real ktriz CLI binary is required, so unlike verify:cli
// this runs unconditionally in CI on every push/PR.
//
// verify:cli covers the same extractSvg/parseCliJson code paths again, but
// end-to-end against the real CLI; this script exists so those code paths
// are still gated on machines/CI runners that don't have the CLI built.
//
// Run with: npm run verify:pure

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { buildEntry } from "./build-entry.mjs";

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
  const outFile = await buildEntry(
    path.join(__dirname, "verify-entry.ts"),
    path.join(os.tmpdir(), `ktriz-verify-pure-${Date.now()}.cjs`),
    __dirname
  );
  const { extractSvg, parseCliJson, isKtrizRenderError } = require(outFile);
  // toRenderError and filterStderr aren't re-exported by verify-entry.ts (it
  // only re-exports what verify:cli needs); import them straight from the
  // TS source isn't possible from a .mjs script without a second bundle, so
  // this script sticks to what's already exported plus extractSvg/
  // parseCliJson, which cover the two findings this suite exists for.

  console.log("extractSvg: single diagram, happy path");
  {
    const svg = extractSvg('println output\n<svg xmlns="x"><rect/></svg>\ntrailing\n');
    check(
      "extracts exactly the svg slice",
      svg === '<svg xmlns="x"><rect/></svg>',
      svg
    );
  }

  console.log("extractSvg: no svg present -> throws with println hint");
  {
    let threw = false;
    let err;
    try {
      extractSvg("just some text, no diagram\n");
    } catch (e) {
      threw = true;
      err = e;
    }
    check("throws", threw);
    check("is a KtrizRenderError", threw && isKtrizRenderError(err));
    check(
      "title is 'No SVG in the script output'",
      threw && err.title === "No SVG in the script output",
      threw && err.title
    );
    check(
      "hint mentions println(fm.renderSvg())",
      threw && err.lines.includes("println(fm.renderSvg())"),
      threw && JSON.stringify(err.lines)
    );
  }

  console.log("extractSvg: kotlin.String return type but empty stdout -> extra hint");
  {
    let err;
    try {
      extractSvg("", "kotlin.String");
    } catch (e) {
      err = e;
    }
    check(
      "includes the 'returns a String but never prints it' hint",
      Boolean(err && err.lines.some((l) => l.includes("returns a String but never prints it"))),
      err && JSON.stringify(err.lines)
    );
  }

  console.log("extractSvg: two diagrams in one script -> rejected, not silently merged");
  {
    const twoSvgs =
      'println(fm1.renderSvg())\n<svg xmlns="x"><rect/></svg>\n' +
      'println(fm2.renderSvg())\n<svg xmlns="x"><circle/></svg>\n';
    let threw = false;
    let err;
    try {
      extractSvg(twoSvgs);
    } catch (e) {
      threw = true;
      err = e;
    }
    check("throws instead of returning a two-root string", threw);
    check("is a KtrizRenderError", threw && isKtrizRenderError(err));
    check(
      "title names the real problem",
      threw && err.title === "Multiple diagrams in one script",
      threw && err.title
    );
  }

  console.log("extractSvg: nested <svg> (valid SVG) is kept whole, not truncated");
  {
    const nested =
      'println(fm.renderSvg())\n' +
      '<svg xmlns="x"><svg x="0" y="0"><rect/></svg><rect/></svg>\n' +
      'trailing\n';
    let svg;
    let threw = false;
    try {
      svg = extractSvg(nested);
    } catch (e) {
      threw = true;
    }
    check("does not throw on a legitimately nested <svg>", !threw);
    check(
      "extracts the whole root element, inner svg included",
      svg === '<svg xmlns="x"><svg x="0" y="0"><rect/></svg><rect/></svg>',
      svg
    );
  }

  console.log("extractSvg: self-closing nested <svg> (valid SVG) is kept whole, not truncated");
  {
    // A self-closing nested element does not open a scope that needs its
    // own </svg> — counting it as a depth increase would make the walk
    // swallow the *root's* closing tag looking for a nested close that
    // never comes, and report "no SVG" for input that is perfectly valid.
    const selfClosingNested =
      'println(fm.renderSvg())\n' +
      '<svg xmlns="x"><svg x="0"/><rect/></svg>\n' +
      'trailing\n';
    let svg;
    let threw = false;
    try {
      svg = extractSvg(selfClosingNested);
    } catch (e) {
      threw = true;
    }
    check("does not throw on a self-closing nested <svg>", !threw);
    check(
      "extracts the whole root element, self-closing inner svg included",
      svg === '<svg xmlns="x"><svg x="0"/><rect/></svg>',
      svg
    );
  }

  console.log("extractSvg: <svg tokens inside an XML comment are not mistaken for markup");
  {
    // A commented-out `<svg …>` (e.g. a diagram variant disabled while
    // experimenting) must not be counted as a real nested open — nor may
    // its incidental "<svg" substring be treated as the multi-diagram
    // case once the real root is found.
    const commented =
      'println(fm.renderSvg())\n' +
      '<svg xmlns="x"><!-- <svg was here --><rect/></svg>\n' +
      'trailing\n';
    let svg;
    let threw = false;
    try {
      svg = extractSvg(commented);
    } catch (e) {
      threw = true;
    }
    check("does not throw when a <svg token only appears inside a comment", !threw);
    check(
      "extracts the whole root element, comment included verbatim",
      svg === '<svg xmlns="x"><!-- <svg was here --><rect/></svg>',
      svg
    );
  }

  console.log("extractSvg: unterminated svg tag -> treated as 'no SVG', not a crash");
  {
    let threw = false;
    let err;
    try {
      extractSvg('<svg xmlns="x"><rect/>'); // no closing </svg> anywhere
    } catch (e) {
      threw = true;
      err = e;
    }
    check("throws", threw);
    check(
      "reports 'no SVG', not a multi-diagram false positive",
      threw && err.title === "No SVG in the script output",
      threw && err.title
    );
  }

  console.log("parseCliJson: success line mixed with println noise");
  {
    const stdout =
      'debug line before\n{"status":"success","returnType":"kotlin.Unit","stdout":"<svg/>"}\ntrailing noise\n';
    const result = parseCliJson(stdout);
    check("parses the JSON line", result !== null, stdout);
    check("status is success", result && result.status === "success");
    check("stdout field carried through", result && result.stdout === "<svg/>");
  }

  console.log("parseCliJson: whole-trimmed-stdout fallback");
  {
    const stdout = '  {"status":"success","returnType":null,"stdout":""}  ';
    const result = parseCliJson(stdout);
    check("falls back to parsing the trimmed whole string", result !== null, stdout);
    check("status is success", result && result.status === "success");
  }

  console.log("parseCliJson: unknown/invalid shape -> null, not a throw");
  {
    const result = parseCliJson('{"status":"success"}\n{"totally":"unrelated"}\n');
    // First line is missing a valid `stdout`/`returnType` shape but still
    // satisfies the loose "status === success" branch of toResultShape, so
    // it should still parse — this pins down that a partially-shaped
    // success object is coerced, not rejected.
    check("loosely-shaped success line still parses", result !== null && result.status === "success");
  }

  console.log("parseCliJson: no JSON anywhere -> null");
  {
    const result = parseCliJson("nothing but plain text\nacross several lines\n");
    check("returns null", result === null, JSON.stringify(result));
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
