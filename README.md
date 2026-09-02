# obsidian-ktriz

Render [kTRIZ](https://ktriz.dev) function models and Su-Field diagrams as
inline SVG in your Obsidian notes.

Source: [ktriz-lang/kTRIZ](https://github.com/ktriz-lang/kTRIZ). Sibling
project to [obsidian-kuml](https://github.com/kuml-dev/obsidian-kuml), which
does the same for [kUML](https://kuml.dev) diagrams.

> [!warning] No sandbox
> `ktriz` code blocks are arbitrary Kotlin scripts. They run with your full
> user privileges — there is no sandbox — the moment a note containing one is
> opened in Reading View or Live Preview. Only open notes from sources you
> trust, the same way you would run a `build.gradle.kts` you didn't write
> yourself. This matches the kTRIZ CLI's own warning: *"A `*.ktriz.kts`
> script is arbitrary Kotlin and runs with the full rights of the invoking
> user. There is no sandbox."*

## Example

````markdown
```ktriz
val fm = functionModel {
    val engine = component("Engine")
    val coolant = component("Coolant")
    useful(from = coolant, to = engine, verb = "cools")
}
println(fm.renderSvg())
```
````

No `import` lines are needed — `functionModel { }`, `suField { }` and
`.renderSvg()` are in scope by default. The `println(…)` on the last line is
required: a `ktriz` block must *print* the SVG it wants rendered, not just
produce it as the script's return value (see Troubleshooting below).

A Su-Field diagram works the same way:

````markdown
```ktriz
val sf = suField {
    val tool = substance("Tool")
    val workpiece = substance("Workpiece")
    val field = field("Mechanical")
    insufficient(from = field, to = workpiece)
}
println(sf.renderSvg())
```
````

## Installation

- **Community Plugin Store**: search for "kTRIZ Diagrams" once the plugin is
  listed there.
- **BRAT**: add `ktriz-lang/obsidian-ktriz` in the
  [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
- **Manual**: download `main.js`, `manifest.json` and `styles.css` from a
  [release](https://github.com/ktriz-lang/obsidian-ktriz/releases) and place
  them in `<vault>/.obsidian/plugins/ktriz/` — the folder name must match the
  manifest `id` (`ktriz`), not the repository name.

## Requirements

The [kTRIZ CLI](https://github.com/ktriz-lang/kTRIZ) must be installed and
either on your `PATH`, or pointed at by an absolute path in the plugin
settings. For a development build:

```bash
cd /path/to/kTRIZ
./gradlew :ktriz-cli:installDist
```

produces a binary at `ktriz-cli/build/install/ktriz/bin/ktriz`, e.g.
`/home/irakli/IdeaProjects/kTRIZ/ktriz-cli/build/install/ktriz/bin/ktriz`.

## Settings

| Setting | Default | Description |
|---|---|---|
| CLI path | `ktriz` | Path to the `ktriz` binary. Use `ktriz` if it's on your `PATH`, or an absolute path. |

## Troubleshooting

- **`ktriz CLI not found` / `spawn ktriz ENOENT`** — the CLI isn't on your
  `PATH`. Set an absolute path in the plugin settings.
- **`No SVG in the script output`** — the script ran but never printed the
  diagram. Add `println(…)` around the last expression
  (`println(fm.renderSvg())`), not just `fm.renderSvg()` on its own. A script
  that returns a `String` without printing it is *not* rendered automatically.
- **`Script failed to compile`** — `line:column` in the message counts from
  the first line of the code block itself, the same numbering your editor
  would show if the block were a standalone `.ktriz.kts` file.
- **`Multiple diagrams in one script`** — a `ktriz` block renders exactly one
  diagram. If you want to compare two models (e.g. a before/after
  function model), put each `println(…renderSvg())` in its own ```ktriz
  block rather than printing both from the same script.
- The first render of a block after opening Obsidian takes roughly 2–3.5
  seconds (JVM startup). Identical blocks render instantly afterwards from an
  in-memory cache, with no spinner.
- At most 3 diagrams render concurrently; additional blocks queue and wait
  for a free slot rather than spawning unbounded JVM processes.

## Not included (on purpose)

- **No editor syntax highlighting.** Kotlin needs a real grammar, not a
  hand-rolled tokenizer — a later wave, if it happens.
- **No pan/drag or download button** in the zoom lightbox — click a diagram
  to view it larger, click outside or press Escape to close.
- **No server mode.** The kTRIZ CLI has no `serve` command; every render
  shells out to `ktriz run`.
- **Mobile is not supported** (`isDesktopOnly: true`) — there is no Node.js
  process access to spawn the CLI from Obsidian's mobile app.

## Backlog

- Have `ktriz run --output json` include the return value when it's a
  `String`, so `println(…)` is no longer required.
- A per-note trust model instead of auto-executing scripts on open.
- Kotlin syntax highlighting in the editor via a real grammar.

## License

Apache License, Version 2.0. See [LICENSE](LICENSE).
