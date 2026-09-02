import { App, PluginSettingTab, Setting } from "obsidian";
import type KtrizPlugin from "../main";

export class KtrizSettingsTab extends PluginSettingTab {
  plugin: KtrizPlugin;

  constructor(app: App, plugin: KtrizPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // No top heading: Obsidian shows the plugin name in the tab header
    // automatically, and the reviewer rejects headings that repeat it.
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Renders ktriz code blocks — kTRIZ function model and Su-Field " +
        "scripts — as inline SVG diagrams, evaluated by the ktriz CLI binary.",
    });

    containerEl.createEl("p", {
      cls: "setting-item-description ktriz-security-note",
      text:
        "ktriz blocks are Kotlin scripts and are executed with your full " +
        "user privileges — there is no sandbox. Only open notes from " +
        "sources you trust.",
    });

    new Setting(containerEl)
      .setName("CLI path")
      .setDesc(
        "Path to the ktriz binary. Use 'ktriz' if it is on your PATH, or " +
          "an absolute path such as " +
          "/home/you/kTRIZ/ktriz-cli/build/install/ktriz/bin/ktriz."
      )
      .addText((text) =>
        text
          .setPlaceholder("ktriz")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (value) => {
            this.plugin.settings.cliPath = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
