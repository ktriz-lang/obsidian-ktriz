// Verifies src/KtrizCliRenderer.ts against the *real* ktriz CLI binary — no
// mocked child_process, no reimplementation of the parsing logic. It bundles
// scripts/verify-entry.ts (which re-exports the production functions) with
// esbuild's JS API, aliasing the "obsidian" import to obsidian-stub.mjs, and
// then requires the bundle and drives it through the CLI's real behaviour.
//
// Run with: npm run verify:cli
// Override the CLI binary with: KTRIZ_CLI=/path/to/ktriz npm run verify:cli

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { buildEntry } from "./build-entry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const CLI_PATH =
  process.env.KTRIZ_CLI ||
  "/home/irakli/IdeaProjects/kTRIZ/ktriz-cli/build/install/ktriz/bin/ktriz";

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

// Case 8 (below) checks that renderViaCli() leaves no temp files behind. The
// `ktriz-obsidian-` prefix is also used by real, concurrent uses of this
// plugin (e.g. Obsidian open and rendering a block while this script runs),
// so counting matches in the *shared* OS temp dir would make the check flaky
// against processes it has nothing to do with. Instead, redirect `os.tmpdir()`
// — which Node re-reads from TMPDIR/TEMP/TMP on every call, not just at
// startup — to a directory made fresh for this run, so only files this run's
// own renderViaCli() calls created can appear in it.
function isolateTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ktriz-verify-tmp-"));
  process.env.TMPDIR = dir;
  process.env.TEMP = dir;
  process.env.TMP = dir;
  return dir;
}

function tmpFileCount(dir) {
  return fs.readdirSync(dir).filter((f) => f.startsWith("ktriz-obsidian-")).length;
}

async function main() {
  console.log(`Using ktriz CLI: ${CLI_PATH}`);
  if (!fs.existsSync(CLI_PATH)) {
    console.error(`ktriz CLI not found at ${CLI_PATH}. Set KTRIZ_CLI to override.`);
    process.exit(1);
  }

  const isolatedTmpDir = isolateTmpDir();
  const outFile = await buildEntry(
    path.join(__dirname, "verify-entry.ts"),
    path.join(isolatedTmpDir, `ktriz-verify-${Date.now()}.cjs`),
    __dirname
  );
  const { renderViaCli, isKtrizRenderError, parseCliJson } = require(outFile);

  const before = tmpFileCount(isolatedTmpDir);

  console.log("Case 1: functionModel + println(fm.renderSvg())");
  {
    const src =
      'val fm = functionModel {\n    val engine = component("Engine")\n    val coolant = component("Coolant")\n    useful(from = coolant, to = engine, verb = "cools")\n}\nprintln(fm.renderSvg())\n';
    try {
      const svg = await renderViaCli(src, CLI_PATH);
      check("resolves with a string", typeof svg === "string");
      check("starts with <svg", svg.startsWith("<svg"), svg.slice(0, 60));
      check("ends with </svg>", svg.endsWith("</svg>"));
      check("no XML declaration", !svg.includes("<?xml"));
    } catch (e) {
      check("case 1 should not throw", false, e && e.message);
    }
  }

  console.log("Case 2: debug println before the SVG");
  {
    const src =
      'println("debug line")\nval fm = functionModel {\n    val engine = component("Engine")\n    val coolant = component("Coolant")\n    useful(from = coolant, to = engine, verb = "cools")\n}\nprintln(fm.renderSvg())\n';
    try {
      const svg = await renderViaCli(src, CLI_PATH);
      check("starts with <svg", svg.startsWith("<svg"));
      check("ends with </svg>", svg.endsWith("</svg>"));
      check("debug line not included in result", !svg.includes("debug line"));
    } catch (e) {
      check("case 2 should not throw", false, e && e.message);
    }
  }

  console.log("Case 3: last line is an expression, no println");
  {
    const src =
      'val fm = functionModel {\n    val engine = component("Engine")\n    val coolant = component("Coolant")\n    useful(from = coolant, to = engine, verb = "cools")\n}\nfm.renderSvg()\n';
    try {
      await renderViaCli(src, CLI_PATH);
      check("case 3 should throw", false);
    } catch (e) {
      check("is KtrizRenderError", isKtrizRenderError(e));
      check(
        "title is 'No SVG in the script output'",
        e.title === "No SVG in the script output",
        e.title
      );
      check(
        "lines[1] is the println hint",
        e.lines[1] === "println(fm.renderSvg())",
        JSON.stringify(e.lines)
      );
      check(
        "kotlin.String hint present",
        e.lines.some((l) => l.includes("returns a String but never prints it")),
        JSON.stringify(e.lines)
      );
    }
  }

  console.log("Case 4: compile error");
  {
    const src = 'val x: Int = "nope"\n';
    try {
      await renderViaCli(src, CLI_PATH);
      check("case 4 should throw", false);
    } catch (e) {
      check("is KtrizRenderError", isKtrizRenderError(e));
      check("code is KTRIZ-S-001", e.code === "KTRIZ-S-001", e.code);
      check("lines.length >= 1", e.lines.length >= 1);
      check(
        "lines[0] starts with '1:12  '",
        Boolean(e.lines[0] && e.lines[0].startsWith("1:12  ")),
        e.lines[0]
      );
    }
  }

  console.log("Case 5: runtime error");
  {
    const src = 'println("before boom")\nerror("boom")\n';
    try {
      await renderViaCli(src, CLI_PATH);
      check("case 5 should throw", false);
    } catch (e) {
      check("is KtrizRenderError", isKtrizRenderError(e));
      check("code is KTRIZ-S-002", e.code === "KTRIZ-S-002", e.code);
      check(
        "lines[0] mentions IllegalStateException and boom",
        Boolean(e.lines[0] && e.lines[0].includes("IllegalStateException") && e.lines[0].includes("boom")),
        e.lines[0]
      );
      check(
        "a later line mentions 'before boom'",
        e.lines.some((l) => l.includes("before boom")),
        JSON.stringify(e.lines)
      );
    }
  }

  console.log("Case 6: nonexistent path -> source_rejected KTRIZ-S-012 (direct CLI call)");
  {
    const { execFile } = require("child_process");
    const stdout = await new Promise((resolve) => {
      execFile(
        CLI_PATH,
        ["run", "/nonexistent/path/does-not-exist.ktriz.kts", "--output", "json"],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
        (_error, out) => resolve(out)
      );
    });
    const result = parseCliJson(stdout);
    check("parses to a result", result !== null, stdout);
    check("status is error", Boolean(result && result.status === "error"));
    check(
      "errorKind is source_rejected",
      Boolean(result && result.errorKind === "source_rejected"),
      result && result.errorKind
    );
    check("code is KTRIZ-S-012", Boolean(result && result.code === "KTRIZ-S-012"), result && result.code);
  }

  console.log("Case 7: oversized script rejected without starting a process");
  {
    const big = "// ".padEnd(1024 * 1024 + 10, "x");
    const start = Date.now();
    try {
      await renderViaCli(big, CLI_PATH);
      check("case 7 should throw", false);
    } catch (e) {
      const elapsed = Date.now() - start;
      check("is KtrizRenderError", isKtrizRenderError(e));
      check("code is KTRIZ-S-015", e.code === "KTRIZ-S-015", e.code);
      check("rejected in under 100ms (no process started)", elapsed < 100, `${elapsed}ms`);
    }
  }

  console.log("Case 8: no leaked temp files after cases 1-5");
  {
    const after = tmpFileCount(isolatedTmpDir);
    check("temp file count unchanged", after === before, `before=${before} after=${after}`);
  }

  console.log("Case 9: temp file is written owner-only (mode 0600) via O_CREAT|O_EXCL");
  {
    // `fs` (the ESM default import above) is the very same builtin module
    // object the bundled production code's `eval("require")("fs")` resolves
    // to — Node caches builtins as a single shared instance regardless of
    // which module required them — so patching a method here intercepts the
    // production call too, without reimplementing or mocking the renderer.
    const originalWriteFileSync = fs.writeFileSync;
    let capturedOptions = null;
    fs.writeFileSync = function (file, data, options) {
      capturedOptions = options;
      return originalWriteFileSync.call(this, file, data, options);
    };
    try {
      await renderViaCli('println("mode check")\n', CLI_PATH);
    } catch {
      // The render's outcome is irrelevant here — only how the temp file
      // was opened matters, and that call happens before the CLI even runs.
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    check("writeFileSync received an options object", capturedOptions !== null);
    check(
      "mode is owner-read-write-only (0600), no group/other bits",
      Boolean(capturedOptions && (capturedOptions.mode & 0o777) === 0o600),
      capturedOptions && capturedOptions.mode !== undefined
        ? `0${capturedOptions.mode.toString(8)}`
        : capturedOptions
    );
    check(
      "flag is 'wx' (O_CREAT|O_EXCL — refuses to follow a pre-existing file/symlink)",
      Boolean(capturedOptions && capturedOptions.flag === "wx"),
      capturedOptions && capturedOptions.flag
    );
  }

  try {
    fs.rmSync(isolatedTmpDir, { recursive: true, force: true });
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
