import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import Notify from 'notify';
import spacetime from 'spacetime';

import { ReadwiseApi, Library, Highlight, Book, Tag } from 'readwiseApi';

interface PluginSettings {
  baseFolderName: string;
  apiToken: string | null;
  lastUpdated: string | null;
  autoSync: boolean;
  highlightSortOldestToNewest: boolean;
  logFile: boolean;
  logFileName: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
  baseFolderName: 'Readwise',
  apiToken: null,
  lastUpdated: null,
  autoSync: true,
  highlightSortOldestToNewest: true,
  logFile: true,
  logFileName: 'Sync.md',
};

export default class ReadwiseMirror extends Plugin {
  settings: PluginSettings;
  readwiseApi: ReadwiseApi;
  notify: Notify;

  private formatTags(tags: Tag[]) {
    return tags.map((tag) => `#${tag.name}`).join(', ');
  }

  private formatHighlight(highlight: Highlight, book: Book) {
    const { id, text, note, location, color, tags } = highlight;
    const locationUrl = `https://readwise.io/to_kindle?action=open&asin=${book['asin']}&location=${location}`;
    const locationBlock = location !== null ? `([${location}](${locationUrl}))` : '';

    const formattedTags = tags.filter((tag) => tag.name !== color);
    const formattedTagStr = this.formatTags(formattedTags);

    return `
${text} ${book.category === 'books' ? locationBlock : ''}${color ? ` %% Color: ${color} %%` : ''} ^${id}${
      note ? `\n\n**Note: ${note}**` : ``
    }${formattedTagStr.length >= 1 ? `\n\n**Tags: ${formattedTagStr}**` : ``}

---
`;
  }

  private formatDate(dateStr: string) {
    return dateStr.split('T')[0];
  }

  async writeLogToMarkdown(library: Library) {
    const vault = this.app.vault;

    let path = `${this.settings.baseFolderName}/${this.settings.logFileName}`;
    const abstractFile = vault.getAbstractFileByPath(path);

    const now = spacetime.now();
    let logString = `# [[${now.format('iso-short')}]] *(${now.time()})*`;

    for (let bookId in library['books']) {
      const book = library['books'][bookId];

      const { title, num_highlights } = book;
      const sanitizedTitle = `${title.replace(':', '-').replace(/[<>"'\/\\|?*]+/g, '')}`;
      const contents = `\n- [[${sanitizedTitle}]] *(${num_highlights} highlights)*`;
      logString += contents;
    }

    try {
      if (abstractFile) {
        // If log file already exists, append to the content instead of overwriting
        const logFile = vault.getFiles().filter((file) => file.name === this.settings.logFileName)[0];
        console.log('logFile:', logFile);

        const logFileContents = await vault.read(logFile);
        vault.modify(logFile, logFileContents + '\n\n' + logString);
      } else {
        vault.create(path, logString);
      }
    } catch (err) {
      console.error(`Readwise: Error writing to sync log file`, err);
    }
  }

  async writeLibraryToMarkdown(library: Library) {
    const vault = this.app.vault;

    // Create parent directories for all categories, if they do not exist
    library['categories'].forEach(async (category: string) => {
      category = category.charAt(0).toUpperCase() + category.slice(1); // Title Case the directory name

      const path = `${this.settings.baseFolderName}/${category}`;
      const abstractFolder = vault.getAbstractFileByPath(path);

      if (!abstractFolder) {
        vault.createFolder(path);
        console.info('Readwise: Successfully created folder', path);
      }
    });

    for (let bookId in library['books']) {
      const book = library['books'][bookId];

      const {
        id,
        title,
        author,
        category,
        num_highlights,
        updated,
        cover_image_url,
        highlights_url,
        highlights,
        last_highlight_at,
        source_url,
        tags,
      } = book;
      const sanitizedTitle = `${title.replace(':', '-').replace(/[<>"'\/\\|?*]+/g, '')}`;

      const formattedHighlights = (this.settings.highlightSortOldestToNewest ? highlights.reverse() : highlights)
        .map((highlight: Highlight) => this.formatHighlight(highlight, book))
        .join('')
        .replace(/---\n$/g, '');

      const authors = author ? author.split(/and |,/) : [];

      let authorStr =
        authors[0] && authors?.length > 1
          ? authors
              .filter((authorName: string) => authorName.trim() != '')
              .map((authorName: string) => `[[${authorName.trim()}]]`)
              .join(', ')
          : author
          ? `[[${author}]]`
          : ``;

      const contents = `%%
ID: ${id}
Updated: ${this.formatDate(updated)}
%%
![](${cover_image_url.replace('SL200', 'SL500').replace('SY160', 'SY500')})

# About
Title: [[${sanitizedTitle}]]
${authors.length > 1 ? 'Authors' : 'Author'}: ${authorStr}
Category: #${category}${tags.length > 1 ? '\nTags: ' + this.formatTags(tags) : ''}
Number of Highlights: ==${num_highlights}==
Last Highlighted: *${last_highlight_at ? this.formatDate(last_highlight_at) : 'Never'}*
Readwise URL: ${highlights_url}${category === 'articles' ? `\nSource URL: ${source_url}\n` : ''}

# Highlights ${formattedHighlights}`;

      let path = `${this.settings.baseFolderName}/${
        category.charAt(0).toUpperCase() + category.slice(1)
      }/${sanitizedTitle}.md`;

      const abstractFile = vault.getAbstractFileByPath(path);

      // Delete old instance of file
      if (abstractFile) {
        try {
          await vault.delete(abstractFile);
        } catch (err) {
          console.error(`Readwise: Attempted to delete file ${path} but no file was found`, err);
        }
      }

      vault.create(path, contents);
    }
  }

  async deleteLibraryFolder() {
    const vault = this.app.vault;
    let path = `${this.settings.baseFolderName}`;

    const abstractFile = vault.getAbstractFileByPath(path);

    // Delete old instance of file
    if (abstractFile) {
      try {
        console.info('Readwise: Attempting to delete entire library at:', abstractFile);
        await vault.delete(abstractFile, true);
        return true;
      } catch (err) {
        console.error(`Readwise: Attempted to delete file ${path} but no file was found`, err);
        return false;
      }
    }
  }

  async sync() {
    if (!this.settings.apiToken) {
      this.notify.notice('Readwise: API Token Required');
      return;
    }

    let library: Library;
    const lastUpdated = this.settings.lastUpdated;

    if (!lastUpdated) {
      this.notify.notice('Readwise: Previous sync not detected...\nDownloading full Readwise library');
      library = await this.readwiseApi.downloadFullLibrary();
    } else {
      this.notify.notice(`Readwise: Checking for new updates since ${this.lastUpdatedHumanReadableFormat()}`);
      library = await this.readwiseApi.downloadUpdates(lastUpdated);
    }

    if (Object.keys(library.books).length > 0) {
      this.writeLibraryToMarkdown(library);

      if (this.settings.logFile) this.writeLogToMarkdown(library);

      this.notify.notice(
        `Readwise: Downloaded ${library.highlightCount} Highlights from ${Object.keys(library.books).length} Sources`
      );
    } else {
      this.notify.notice(`Readwise: No new content available`);
    }

    this.settings.lastUpdated = new Date().toISOString();
    await this.saveSettings();
    this.notify.setStatusBarText(`Readwise: Synced ${this.lastUpdatedHumanReadableFormat()}`);
  }

  async download() {
    // Reset lastUpdate setting to force full download
    this.settings.lastUpdated = null;
    await this.saveSettings();
    await this.sync();
  }

  async deleteLibrary() {
    this.settings.lastUpdated = null;
    await this.saveSettings();

    if (await this.deleteLibraryFolder()) {
      this.notify.notice('Readwise: library folder deleted');
    } else {
      this.notify.notice('Readwise: Error deleting library folder');
    }

    this.notify.setStatusBarText('Readwise: Click to Sync');
  }

  lastUpdatedHumanReadableFormat() {
    return spacetime.now().since(spacetime(this.settings.lastUpdated)).rounded;
  }

  async onload() {
    await this.loadSettings();

    const statusBarItem = this.addStatusBarItem();

    this.notify = new Notify(statusBarItem);

    if (!this.settings.apiToken) {
      this.notify.notice('Readwise: API Token not detected\nPlease enter in configuration page');
      this.notify.setStatusBarText('Readwise: API Token Required');
    } else {
      this.readwiseApi = new ReadwiseApi(this.settings.apiToken, this.notify);
      if (this.settings.lastUpdated)
        this.notify.setStatusBarText(`Readwise: Updated ${this.lastUpdatedHumanReadableFormat()}`);
      else this.notify.setStatusBarText(`Readwise: Click to Sync`);
    }

    this.registerDomEvent(statusBarItem, 'click', this.sync.bind(this));

    this.addCommand({
      id: 'download',
      name: 'Download entire Readwise library (force)',
      callback: this.download.bind(this),
    });

    this.addCommand({
      id: 'test',
      name: 'Test Readwise API key',
      callback: async () => {
        const isTokenValid = await this.readwiseApi.checkToken();
        this.notify.notice('Readwise: ' + (isTokenValid ? 'Token is valid' : 'INVALID TOKEN'));
      },
    });

    this.addCommand({
      id: 'delete',
      name: 'Delete Readwise library',
      callback: this.deleteLibrary.bind(this),
    });

    this.addCommand({
      id: 'update',
      name: 'Sync new highlights',
      callback: this.sync.bind(this),
    });

    this.registerInterval(
      window.setInterval(() => {
        if (/Synced/.test(this.notify.getStatusBarText())) {
          this.notify.setStatusBarText(`Readwise: Synced ${this.lastUpdatedHumanReadableFormat()}`);
        }
      }, 1000)
    );

    this.addSettingTab(new ReadwiseMirrorSettingTab(this.app, this, this.notify));

    if (this.settings.autoSync) this.sync();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class ReadwiseMirrorSettingTab extends PluginSettingTab {
  plugin: ReadwiseMirror;
  notify: Notify;

  constructor(app: App, plugin: ReadwiseMirror, notify: Notify) {
    super(app, plugin);
    this.plugin = plugin;
    this.notify = notify;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h1', { text: 'Readwise Sync Configuration' });

    const apiTokenFragment = document.createDocumentFragment();
    apiTokenFragment.createEl('span', null, (spanEl) =>
      spanEl.createEl('a', null, (aEl) => (aEl.innerText = aEl.href = 'https://readwise.io/access_token'))
    );

    new Setting(containerEl)
      .setName('Enter your Readwise Access Token')
      .setDesc(apiTokenFragment)
      .addText((text) =>
        text
          .setPlaceholder('Readwise Access Token')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            if (!value) return;
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
            this.plugin.readwiseApi = new ReadwiseApi(value, this.notify);
          })
      );

    new Setting(containerEl)
      .setName('Readwise library folder name')
      .setDesc('Default: Readwise')
      .addText((text) =>
        text
          .setPlaceholder('Readwise')
          .setValue(this.plugin.settings.baseFolderName)
          .onChange(async (value) => {
            if (!value) return;
            this.plugin.settings.baseFolderName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto Sync when starting')
      .setDesc('Automatically syncs new highlights after opening Obsidian')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sort Highlights in notes from Oldest to Newest')
      .setDesc(
        'If checked, highlights will be listed from oldest to newest. Unchecked, newest highlights will appear first.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.highlightSortOldestToNewest).onChange(async (value) => {
          this.plugin.settings.highlightSortOldestToNewest = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync Log')
      .setDesc('Save sync log to file in Library')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.logFile).onChange(async (value) => {
          this.plugin.settings.logFile = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync Log File Name')
      .setDesc('Default: Sync.md')
      .addText((text) =>
        text
          .setPlaceholder('Sync.md')
          .setValue(this.plugin.settings.logFileName)
          .onChange(async (value) => {
            if (!value) return;
            this.plugin.settings.logFileName = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
