import { BrowserWindow, session } from "electron";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { isPublicAddress } from "../lib/public-address";
import { boardUrl } from "../lib/board-identity";
import { captureBoardPage, isFigmaCareers, type BoardPage } from "./board-page";
import { isNetflixSearch, NetflixBoardPages } from "./netflix-board";

export type BoardReader = { open(url: string): Promise<void>; read(): Promise<BoardPage>; next(id: string): Promise<void>; close(): void };
const pause = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
  signal.addEventListener("abort", abort, { once: true });
});

export class BoardBrowser implements BoardReader {
  private window: BrowserWindow;
  private source = "";
  private previous = "";
  private navigationError = "";
  private lastPage: BoardPage | null = null;
  private netflix: NetflixBoardPages | null = null;
  private abort: () => void;
  constructor(private signal: AbortSignal) {
    const isolated = session.fromPartition(`boards-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", event => event.preventDefault());
    const checked = new Map<string, boolean>();
    isolated.webRequest.onBeforeRequest((details, callback) => {
      if (signal.aborted) { callback({ cancel: true }); return; }
      if (/^(data:|blob:)/.test(details.url) && details.resourceType !== "mainFrame") { callback({}); return; }
      let url: URL;
      try { url = boardUrl(details.url); } catch { callback({ cancel: true }); return; }
      const cached = checked.get(url.hostname);
      if (cached !== undefined) { callback({ cancel: !cached }); return; }
      void lookup(url.hostname, { all: true }).then(addresses => {
        const publicHost = addresses.length > 0 && addresses.every(address => isPublicAddress(address.address));
        checked.set(url.hostname, publicHost); callback({ cancel: !publicHost || signal.aborted });
      }).catch(() => callback({ cancel: true }));
    });
    this.window = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, backgroundThrottling: false, devTools: false } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (event: Electron.Event, target: string) => {
      try {
        const next = boardUrl(target), original = boardUrl(this.source);
        if (next.origin !== original.origin || next.pathname.replace(/\/$/, "") !== original.pathname.replace(/\/$/, "")) throw new Error();
        for (const [key, value] of original.searchParams) {
          if (/^(page|pagesize|offset|start|cursor)$/i.test(key)) continue;
          if (next.searchParams.getAll(key).join("\0") !== original.searchParams.getAll(key).join("\0") || !value && !next.searchParams.has(key)) throw new Error();
        }
      } catch { event.preventDefault(); this.navigationError = "The board redirected or changed its search filters. Save the direct results link and try again."; }
    };
    this.window.webContents.on("will-navigate", guard);
    this.window.webContents.on("will-redirect", (event, target, _inPlace, isMainFrame) => {
      if (isMainFrame) guard(event, target);
    });
    this.abort = () => this.close(); signal.addEventListener("abort", this.abort, { once: true });
  }
  async open(url: string) {
    this.signal.throwIfAborted();
    const target = boardUrl(url); this.source = target.href;
    this.netflix = null; this.lastPage = null; this.previous = ""; this.navigationError = "";
    if (isNetflixSearch(target)) {
      const isolated = this.window.webContents.session;
      this.netflix = new NetflixBoardPages(target, (input, init) => isolated.fetch(input, init), this.signal);
      return;
    }
    await Promise.race([this.window.loadURL(this.source), pause(30000, this.signal).then(() => { throw new Error("The board took too long to load. Try again."); })]);
  }
  private async snapshot(): Promise<BoardPage> {
    this.signal.throwIfAborted();
    if (this.navigationError) throw new Error(this.navigationError);
    const section = isFigmaCareers(boardUrl(this.source)) ? "job-openings" : "";
    const result: BoardPage = await this.window.webContents.executeJavaScript(`(${captureBoardPage.toString()})(${JSON.stringify(section)})`);
    const original = boardUrl(this.source), current = boardUrl(result.url);
    if (current.origin !== original.origin || current.pathname.replace(/\/$/, "") !== original.pathname.replace(/\/$/, "") ||
        original.hash && current.hash !== original.hash || [...original.searchParams.keys()].some(key =>
          !/^(page|pagesize|offset|start|cursor)$/i.test(key) && current.searchParams.getAll(key).join("\0") !== original.searchParams.getAll(key).join("\0"))) {
      throw new Error("The board changed its search filters. Save the direct results link and try again.");
    }
    if (result.candidates.length > 1000 || result.controls.length > 100) throw new Error("This page has too many links to check completely. Save a more specific filtered link.");
    if (result.blocked) throw new Error("This board is asking for a browser check. Open its link and try again later.");
    return result;
  }
  async read() {
    if (this.netflix) return this.netflix.read();
    const started = Date.now();
    let previous = "", stable = 0, result: BoardPage;
    while (true) {
      result = await this.snapshot();
      const signature = JSON.stringify([result.pageNumber, result.candidates.map(item => item.url)]);
      const loaded = !result.loading && (result.candidates.length > 0 || result.empty) && signature !== this.previous;
      stable = loaded && signature === previous ? stable + 1 : 0;
      if (stable >= 2) break;
      if (Date.now() - started > 30000) throw new Error("The board's results did not finish loading. Try checking this board again.");
      previous = signature; await pause(500, this.signal);
    }
    const collected = new Map(result.candidates.map(candidate => [candidate.url, candidate]));
    let bottomStable = 0, previousHeight = -1, previousCount = -1;
    for (let step = 0; step < 100; step++) {
      this.signal.throwIfAborted();
      await this.window.webContents.executeJavaScript("window.scrollBy(0, Math.max(600, window.innerHeight * .85))");
      await pause(350, this.signal);
      result = await this.snapshot();
      for (const candidate of result.candidates) collected.set(candidate.url, candidate);
      if (collected.size > 10000) throw new Error("This board has too many links to check completely. Use a more specific filtered link.");
      bottomStable = result.atBottom && !result.loading && result.height === previousHeight && collected.size === previousCount ? bottomStable + 1 : 0;
      if (bottomStable >= 3) {
        this.lastPage = { ...result, candidates: [...collected.values()].map((candidate, index) => ({ ...candidate, id: `l${index}` })) };
        return this.lastPage;
      }
      previousHeight = result.height; previousCount = collected.size;
    }
    throw new Error("This board kept loading more results. Use a more specific filtered link.");
  }
  async next(id: string) {
    if (this.netflix) { this.netflix.next(id); return; }
    if (!/^c\d+$/.test(id)) throw new Error("Invalid pagination control.");
    const before = await this.snapshot();
    const expected = this.lastPage?.controls.find(control => control.id === id);
    if (!expected || !before.controls.some(control => control.id === id && !control.disabled && control.text === expected.text && control.context === expected.context)) throw new Error("The board's next-page control changed. Try the check again.");
    this.previous = JSON.stringify([before.pageNumber, before.candidates.map(item => item.url)]);
    const clicked = await this.window.webContents.executeJavaScript(`(() => {
      const control = document.querySelector('[data-zebby-board-control="${id}"]');
      if (!control) return false; control.click(); return true;
    })()`);
    if (!clicked) throw new Error("The next page could not be opened.");
    await pause(300, this.signal);
  }
  close() {
    this.signal.removeEventListener("abort", this.abort);
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
