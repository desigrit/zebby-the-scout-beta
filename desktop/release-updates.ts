const REPOSITORY = "desigrit/zebby-the-scout-beta";
export const RELEASE_REPOSITORY = `https://github.com/${REPOSITORY}`;
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases`;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export type UpdateState = {
  currentVersion: string;
  checking: boolean;
  checkedAt: string;
  error: string;
  available: { version: string; installerUrl: string; releaseUrl: string; size: number; sha256: string } | null;
  download: { phase: "idle" | "downloading" | "verifying" | "ready" | "installing" | "error"; received: number; total: number; error: string };
};

function versionParts(value: string) {
  const match = /^v?(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-beta\.(0|[1-9]\d{0,7}))?$/.exec(value);
  if (!match) return null;
  // A final release follows every numbered beta with the same three components.
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])];
}

export function newerVersion(latest: string, current: string) {
  const next = versionParts(latest), installed = versionParts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < next.length; index++) if (next[index] !== installed[index]) return next[index] > installed[index];
  return false;
}

export function isInstallerVersion(value: string) { return !value.startsWith("v") && versionParts(value) !== null; }

export function installerFilename(version: string, platform: string, arch: string) {
  if (!isInstallerVersion(version)) throw new Error("The update version is invalid.");
  const suffix = platform === "win32" && ["x64", "arm64"].includes(arch) ? `win-${arch}.exe`
    : platform === "darwin" && arch === "arm64" ? "mac-arm64.dmg" : "";
  if (!suffix) throw new Error("An update installer is not available for this computer.");
  return `Zebby-Beta-${version}-${suffix}`;
}

function publishedTag(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const release = payload as Record<string, unknown>;
  return release.draft === false && typeof release.tag_name === "string" && versionParts(release.tag_name) ? release.tag_name : "";
}

export function updateFromRelease(payload: unknown, current: string, platform: string, arch: string): UpdateState["available"] {
  const tag = publishedTag(payload);
  if (!tag || !newerVersion(tag, current)) return null;
  const release = payload as Record<string, unknown>;
  const version = tag.replace(/^v/, "");
  const filename = installerFilename(version, platform, arch);
  const installerUrl = `${RELEASE_REPOSITORY}/releases/download/${tag}/${filename}`;
  const releaseUrl = `${RELEASE_REPOSITORY}/releases/tag/${tag}`;
  const asset = Array.isArray(release.assets) ? release.assets.find((item) =>
    item && item.name === filename && item.browser_download_url === installerUrl && item.state === "uploaded" && Number.isSafeInteger(item.size) && item.size > 0) : null;
  if (release.html_url !== releaseUrl || !asset) {
    throw new Error("The update installer is not available yet. Check again shortly.");
  }
  if (typeof asset.digest !== "string" || !/^sha256:[\da-f]{64}$/i.test(asset.digest)) throw new Error("The update verification information is not available yet.");
  return { version, installerUrl, releaseUrl, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() };
}

export class ReleaseUpdates {
  private readonly options: { version: string; platform: string; arch: string; channel?: "direct" | "store"; enabled?: boolean;
    fetch?: typeof fetch; onChange?: (value: UpdateState) => void; onError?: (error: unknown) => void; now?: () => number };
  private value: UpdateState;
  private pending: Promise<UpdateState> | null = null;
  private lastAttempt: number | null = null;
  constructor(options: { version: string; platform: string; arch: string; channel?: "direct" | "store"; enabled?: boolean;
    fetch?: typeof fetch; onChange?: (value: UpdateState) => void; onError?: (error: unknown) => void; now?: () => number }) {
    this.options = options;
    this.value = { currentVersion: options.version, checking: false, checkedAt: "", error: "", available: null,
      download: { phase: "idle", received: 0, total: 0, error: "" } };
  }
  get state() { return structuredClone(this.value); }
  setDownload(download: UpdateState["download"]) { if (this.options.channel !== "store") this.change({ download }); }
  private change(value: Partial<UpdateState>) {
    this.value = { ...this.value, ...value }; this.options.onChange?.(this.state);
  }
  check(force = false): Promise<UpdateState> {
    if (this.options.enabled === false) return Promise.resolve(this.state);
    if (this.options.channel === "store") return Promise.resolve(this.state);
    if (this.pending) return this.pending;
    if (!["idle", "error"].includes(this.value.download.phase)) return Promise.resolve(this.state);
    const now = this.options.now?.() ?? Date.now();
    if (!force && this.lastAttempt !== null && now - this.lastAttempt < CHECK_INTERVAL) return Promise.resolve(this.state);
    this.lastAttempt = now;
    this.change({ checking: true, error: "" });
    this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async run() {
    try {
      const signal = AbortSignal.timeout(20_000);
      let newest: unknown = null, newestTag = this.options.version;
      for (let page = 1; ; page++) {
        const response = await (this.options.fetch || fetch)(`${RELEASES_API}?per_page=20&page=${page}`, {
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Zebby-Beta" }, signal });
        if (!response.ok) throw new Error(`GitHub update check returned ${response.status}.`);
        const body = await response.text();
        if (body.length > 2_000_000) throw new Error("The update response was too large.");
        const releases: unknown = JSON.parse(body);
        if (!Array.isArray(releases)) throw new Error("The release list was incomplete.");
        for (const release of releases) {
          const tag = publishedTag(release);
          if (tag && newerVersion(tag, newestTag)) { newest = release; newestTag = tag; }
        }
        if (!response.headers.get("link")?.includes('rel="next"')) break;
      }
      const available = updateFromRelease(newest, this.options.version, this.options.platform, this.options.arch);
      this.change({ available, checkedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), checking: false, error: "" });
    } catch (error) {
      this.options.onError?.(error);
      this.change({ checking: false, error: "Could not check for updates. Try again." });
    }
    return this.state;
  }
}
