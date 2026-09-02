// Minimal stand-in for the "obsidian" module, used only so that
// scripts/verify-cli.mjs can bundle and run the real src/KtrizCliRenderer.ts
// production code outside of the Obsidian app (which is not available in
// CI or in this build-verification step). Only the exports actually
// imported by src/KtrizCliRenderer.ts and main.ts need to exist here.

export const Platform = {
  isDesktopApp: true,
};

export class Modal {
  constructor(app) {
    this.app = app;
    this.modalEl = { addClass() {} };
    this.contentEl = {
      addClass() {},
      appendChild() {},
      empty() {},
    };
  }
  open() {}
  close() {}
}

export class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  addSettingTab() {}
  registerMarkdownCodeBlockProcessor() {}
  loadData() {
    return Promise.resolve(null);
  }
  saveData() {
    return Promise.resolve();
  }
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = {
      empty() {},
      createEl() {
        return { createEl() {} };
      },
    };
  }
}

export class Setting {
  constructor(_containerEl) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText(cb) {
    cb({
      setPlaceholder: () => ({ setValue: () => ({ onChange: () => {} }) }),
    });
    return this;
  }
}
