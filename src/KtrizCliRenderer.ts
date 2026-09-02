import { Platform } from "obsidian";

/** Mirrors `KtrizScriptHost.MAX_SCRIPT_BYTES` in the kTRIZ CLI. */
export const MAX_SCRIPT_BYTES = 1024 * 1024;
export const CLI_TIMEOUT_MS = 60_000;
export const CLI_MAX_BUFFER = 8 * 1024 * 1024;

export interface KtrizDiagnostic {
  severity: string;
  message: string;
  line: number | null;
  column: number | null;
}

export type KtrizCliResult =
  | { status: "success"; returnType: string | null; stdout: string }
  | {
      status: "error";
      errorKind: "compilation_error";
      code: string;
      diagnostics: KtrizDiagnostic[];
    }
  | {
      status: "error";
      errorKind: "runtime_error";
      code: string;
      message: string;
      exceptionClass: string;
      stdout: string;
    }
  | { status: "error"; errorKind: "not_evaluated"; code: string; message: string }
  | { status: "error"; errorKind: "source_rejected"; code: string; message: string };

const VALID_ERROR_KINDS = new Set([
  "compilation_error",
  "runtime_error",
  "not_evaluated",
  "source_rejected",
]);

/**
 * Structured render failure. Carries a nominal flag so `isKtrizRenderError`
 * works reliably even across bundle/realm boundaries, where `instanceof`
 * can silently fail.
 */
export class KtrizRenderError extends Error {
  readonly __ktrizRenderError = true as const;
  readonly title: string;
  readonly lines: string[];
  readonly code?: string;

  constructor(title: string, lines: string[], code?: string) {
    super(lines.length > 0 ? `${title}: ${lines.join(" | ")}` : title);
    this.name = "KtrizRenderError";
    this.title = title;
    this.lines = lines;
    this.code = code;
  }
}

export function isKtrizRenderError(e: unknown): e is KtrizRenderError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as Record<string, unknown>).__ktrizRenderError === true
  );
}

/**
 * Validate that a JSON-parsed value has one of the five shapes the ktriz
 * CLI's `--output json` mode can produce. Returns `null` on any mismatch
 * rather than a half-populated result — callers must be able to trust that
 * a non-null return is fully typed.
 */
function toResultShape(value: unknown): KtrizCliResult | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.status === "success") {
    return {
      status: "success",
      returnType: typeof obj.returnType === "string" ? obj.returnType : null,
      stdout: typeof obj.stdout === "string" ? obj.stdout : "",
    };
  }
  if (obj.status === "error" && typeof obj.errorKind === "string" && VALID_ERROR_KINDS.has(obj.errorKind)) {
    return obj as unknown as KtrizCliResult;
  }
  return null;
}

/**
 * Parse the ktriz CLI's `--output json` stdout. The CLI prints one compact
 * JSON object; user script output (via `println`) may precede or interleave
 * with it, so we take the first line that starts with `{` and try that
 * before falling back to parsing the whole trimmed stdout.
 */
export function parseCliJson(stdout: string): KtrizCliResult | null {
  const lines = stdout.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const shaped = toResultShape(parsed);
      if (shaped) return shaped;
    } catch {
      // Not valid JSON on this line — keep looking.
    }
  }
  try {
    const parsed = JSON.parse(stdout.trim());
    return toResultShape(parsed);
  } catch {
    return null;
  }
}

/**
 * Format one line per diagnostic/message, no colours, no icons — a single
 * scannable list rather than a colour-coded blob.
 */
export function toRenderError(result: KtrizCliResult): KtrizRenderError {
  if (result.status !== "error") {
    return new KtrizRenderError("Unexpected renderer result", [
      "The ktriz CLI returned a result that was not an error, but toRenderError was called anyway.",
    ]);
  }
  switch (result.errorKind) {
    case "compilation_error": {
      const lines = result.diagnostics.map((d) => {
        const loc = `${d.line ?? "?"}:${d.column ?? "?"}`;
        const prefix = d.severity !== "ERROR" ? `[${d.severity}] ` : "";
        return `${loc}  ${prefix}${d.message}`;
      });
      return new KtrizRenderError("Script failed to compile", lines, result.code);
    }
    case "runtime_error": {
      const lines = [`${result.exceptionClass}: ${result.message}`];
      if (result.stdout.trim() !== "") {
        lines.push("Output before the failure:");
        lines.push(result.stdout.slice(0, 200));
      }
      return new KtrizRenderError("Script threw at runtime", lines, result.code);
    }
    case "not_evaluated":
      return new KtrizRenderError("Script was not evaluated", [result.message], result.code);
    case "source_rejected":
      return new KtrizRenderError("Script rejected", [result.message], result.code);
  }
}

/**
 * Pull the `<svg …>…</svg>` slice out of the CLI's stdout, discarding the
 * leading XML declaration (which breaks `DOMParser` once anything precedes
 * it) and any `println` output before or after it.
 *
 * A ktriz block renders exactly one diagram — but a single diagram can
 * legitimately contain *nested* `<svg>` elements (e.g. a hand-composed
 * before/after wrapper embedding two `renderSvg()` outputs as children), so
 * the end of the root element cannot be found with a plain `indexOf`
 * `</svg>` lookup: that matches the *first* closing tag, which for nested
 * input is the inner element's close, not the root's — truncating the
 * slice mid-root and leaving an unbalanced `<svg>` count. Instead this
 * walks forward from `start`, tracking `<svg`/`</svg>` nesting depth, and
 * takes the `</svg>` that brings depth back to zero as the true end of the
 * root element. Finding a further `<svg` *after* that point means the
 * script printed a second, sibling diagram (e.g. two independent
 * `println(…renderSvg())` calls) — that is reported explicitly rather than
 * silently concatenated into a string with two XML root elements, which
 * `DOMParser` would otherwise turn into a `parsererror` three call frames
 * away in `injectSvg` instead of a message that names the actual problem.
 *
 * Throws a `KtrizRenderError` when no SVG is present — the single most
 * common first-run mistake is a script whose last line is an expression
 * instead of `println(…)`.
 */
export function extractSvg(stdout: string, returnType?: string | null): string {
  const start = stdout.indexOf("<svg");
  const end = start < 0 ? -1 : findMatchingSvgEnd(stdout, start);
  if (start < 0 || end < 0) {
    const lines = [
      "The script ran successfully but printed no SVG. A ktriz block must " +
        "print the rendered diagram itself — the last line is usually:",
      "println(fm.renderSvg())",
    ];
    if (returnType === "kotlin.String" && stdout.trim() === "") {
      lines.push(
        "Your script returns a String but never prints it — wrap the last expression in println(…)."
      );
    }
    if (stdout.trim() !== "") {
      lines.push("Printed instead:");
      lines.push(stdout.slice(0, 200));
    }
    throw new KtrizRenderError("No SVG in the script output", lines);
  }

  const nextStart = stdout.indexOf("<svg", end);
  if (nextStart >= 0) {
    throw new KtrizRenderError("Multiple diagrams in one script", [
      "This script printed more than one <svg>…</svg> root — a ktriz code " +
        "block renders exactly one diagram.",
      "Split the comparison into separate ```ktriz blocks (one " +
        "println(…renderSvg()) per block) instead of printing several " +
        "diagrams from the same script.",
    ]);
  }

  return stdout.slice(start, end);
}

/**
 * Given the index of the root `<svg` occurrence, walk forward tracking
 * open/close depth and return the index just past the `</svg>` that
 * closes it — i.e. the end of the *root* element, correctly skipping past
 * any nested `<svg>…</svg>` children. Returns -1 if depth never returns to
 * zero (no matching close for the root, e.g. an unterminated tag).
 *
 * Two things beyond plain `<svg`/`</svg>` token-matching are handled
 * explicitly, because both are legal SVG that a hand-composed before/after
 * wrapper can plausibly contain:
 *  - a self-closing nested element (`<svg x="0"/>`) does not open a scope
 *    that needs a later `</svg>` to close — counting it as a depth
 *    increase would make the walk consume the *next* unrelated `</svg>`
 *    looking for a close that will never come;
 *  - an XML comment (`<!-- … -->`) is skipped wholesale before its
 *    contents are scanned for tokens at all, so a `<svg` or `</svg>`
 *    that only exists as commented-out text never perturbs the depth
 *    count.
 * This is still a lexical walk, not a real XML parser — it does not
 * understand CDATA sections or a `>` inside a quoted attribute value, for
 * instance — but it covers the shapes the kTRIZ CLI itself ever emits
 * (which never has either) plus the two most likely hand-edited variants.
 */
function findMatchingSvgEnd(stdout: string, start: number): number {
  let depth = 0;
  let cursor = start;
  while (cursor < stdout.length) {
    const nextComment = stdout.indexOf("<!--", cursor);
    const nextOpen = stdout.indexOf("<svg", cursor);
    const nextClose = stdout.indexOf("</svg>", cursor);
    if (nextClose < 0) return -1;

    const opensBeforeClose = nextOpen >= 0 && nextOpen < nextClose;
    const commentIsNext =
      nextComment >= 0 &&
      nextComment < nextClose &&
      (!opensBeforeClose || nextComment < nextOpen);

    if (commentIsNext) {
      const commentEnd = stdout.indexOf("-->", nextComment + "<!--".length);
      if (commentEnd < 0) return -1; // unterminated comment
      cursor = commentEnd + "-->".length;
      continue;
    }

    if (opensBeforeClose) {
      const tagEnd = stdout.indexOf(">", nextOpen);
      if (tagEnd < 0) return -1; // unterminated opening tag
      const selfClosing = stdout[tagEnd - 1] === "/";
      if (!selfClosing) depth++;
      cursor = tagEnd + 1;
    } else {
      depth--;
      cursor = nextClose + "</svg>".length;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

/**
 * Drop known-benign JVM/SLF4J startup noise from stderr. Only call this in
 * an error path — a non-empty stderr is never itself a failure signal (the
 * CLI prints `sun.misc.Unsafe` deprecation warnings on every successful run).
 */
export function filterStderr(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return false;
      if (trimmed.startsWith("WARNING:")) return false;
      if (trimmed.startsWith("SLF4J")) return false;
      if (trimmed.startsWith("Picked up ")) return false;
      return true;
    })
    .join("\n");
}

/**
 * Render one ktriz script by shelling out to the ktriz CLI's `run` command
 * with `--output json`, and extracting the SVG it prints.
 *
 * `source` is written to a temp file byte-for-byte — no prelude, no
 * trimming, no injected `println` — because the CLI reports compile
 * diagnostics as 1-based line/column numbers relative to that file, and any
 * prepended line would shift every diagnostic the user sees.
 *
 * The file lives in its own `mkdtemp`-created directory (mode 0700, owner
 * only) rather than directly under the shared, world-writable `os.tmpdir()`
 * — writing straight into `/tmp` under a predictable
 * `ktriz-obsidian-<timestamp>-<seq>` name made the script content (private
 * vault/note text) readable by any other local account for the render's
 * whole duration, and the predictable name was also a symlink-planting
 * target on platforms without kernel-level protected-symlink hardening.
 * `mkdtemp`'s per-call random suffix makes the directory both unpredictable
 * and exclusively owned before anything is written into it, so a fresh
 * directory alone is sufficient uniqueness — no separate sequence counter
 * is needed to avoid same-millisecond collisions the way the old flat
 * `os.tmpdir()`-relative filename needed one. The file itself is still
 * written with an explicit `0o600` mode and the `wx` flag
 * (`O_CREAT|O_EXCL`, refuses to follow a pre-existing symlink or file) as a
 * second layer, independent of the directory's own permissions.
 */
export async function renderViaCli(source: string, cliPath: string): Promise<string> {
  if (!Platform.isDesktopApp) {
    throw new KtrizRenderError("Desktop only", [
      "Rendering ktriz diagrams requires the ktriz CLI, which only runs in the desktop app.",
    ]);
  }

  // Node builtins are loaded lazily via eval("require") rather than a
  // static import, so this module can still be bundled without a
  // module-load-time require() call that would fail on mobile (Capacitor
  // has no Node.js runtime, and a static import throws immediately there
  // even though the code path above never executes on mobile).
  const req = eval("require") as NodeRequire;
  const childProcess = req("child_process") as typeof import("child_process");
  const fs = req("fs") as typeof import("fs");
  const os = req("os") as typeof import("os");
  const path = req("path") as typeof import("path");

  if (Buffer.byteLength(source, "utf8") > MAX_SCRIPT_BYTES) {
    throw new KtrizRenderError(
      "Script too large",
      [`ktriz scripts are limited to ${MAX_SCRIPT_BYTES} bytes (1 MiB).`],
      "KTRIZ-S-015"
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ktriz-obsidian-"));
  const inFile = path.join(tmpDir, "source.ktriz.kts");
  fs.writeFileSync(inFile, source, { encoding: "utf-8", mode: 0o600, flag: "wx" });

  // Wrapped in try/finally rather than cleaning up inside the execFile
  // callback: `execFile` itself can throw synchronously (e.g.
  // ERR_INVALID_ARG_VALUE from a NUL byte in a `cliPath` sourced from
  // Settings) before it ever registers a callback, which previously left
  // `tmpDir` — and the private script content in it — behind permanently.
  // A throw inside the Promise executor still rejects the promise per spec,
  // so `await` below observes it and `finally` still runs.
  try {
    return await new Promise<string>((resolve, reject) => {
      childProcess.execFile(
        cliPath,
        ["run", inFile, "--output", "json"],
        { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER },
        (error, stdout, stderr) => {
          // Everything below is wrapped defensively: this callback fires
          // asynchronously (on process exit), outside the Promise
          // constructor's own synchronous try/catch, so an unexpected throw
          // here (e.g. a CLI JSON shape that passes the loose shape check but
          // has a malformed field) would otherwise leave the returned promise
          // permanently unsettled — a spinner stuck forever instead of an
          // error message.
          try {
            const result = parseCliJson(stdout);
            if (result) {
              if (result.status === "success") {
                resolve(extractSvg(result.stdout, result.returnType));
              } else {
                reject(toRenderError(result));
              }
              return;
            }

            // parseCliJson found no valid JSON — the CLI itself never
            // started, was killed, or failed in a way that produced no
            // structured output.
            if (error && error.code === "ENOENT") {
              reject(
                new KtrizRenderError("ktriz CLI not found", [
                  `Could not find or run "${cliPath}". Set the CLI path in Settings.`,
                ])
              );
              return;
            }
            if (error && (error.killed === true || error.signal)) {
              reject(
                new KtrizRenderError("ktriz CLI timed out", [
                  `No result after ${CLI_TIMEOUT_MS / 1000} s.`,
                ])
              );
              return;
            }
            reject(
              new KtrizRenderError("ktriz CLI failed", [
                filterStderr(stderr) || error?.message || "no output",
              ])
            );
          } catch (e) {
            if (isKtrizRenderError(e)) {
              reject(e);
            } else {
              reject(
                new KtrizRenderError("ktriz CLI returned an unexpected result", [
                  e instanceof Error ? e.message : String(e),
                ])
              );
            }
          }
        }
      );
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort — nothing actionable if cleanup fails.
    }
  }
}
