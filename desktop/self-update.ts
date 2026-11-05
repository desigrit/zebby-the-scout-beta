import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { installerFilename, isInstallerVersion, RELEASE_REPOSITORY, type UpdateState } from "./release-updates.ts";

const execute = promisify(execFile);
type Release = NonNullable<UpdateState["available"]>;
type Prepared = { version: string; installer: string; target?: string; staged?: string; backup?: string; helper?: string };
type UpdaterOptions = { folder: string; platform: string; executable: string; arch?: string;
  onChange: (state: UpdateState["download"]) => void; fetch?: typeof fetch;
  run?: (file: string, args: string[]) => Promise<{ stdout: string }>; launch?: (file: string, args: string[]) => Promise<void> };
const UUID = "[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}";

export function macApplicationPath(executable: string) {
  const folder = path.resolve(path.dirname(executable), "../..");
  if (executable.startsWith("/Volumes/") || folder.startsWith("/Volumes/") || path.basename(folder) !== "Zebby - Beta.app" || path.basename(path.dirname(executable)) !== "MacOS" ||
      path.basename(path.dirname(path.dirname(executable))) !== "Contents") {
    throw new Error("Install Zebby - Beta in Applications before using automatic updates.");
  }
  return folder;
}

export function macUpdateScript() {
  return `#!/bin/sh
set -eu
pid="$1"
live="$2"
staged="$3"
backup="$4"
log="$5"
case "$pid" in ''|*[!0-9]*) exit 1 ;; esac
parent="\${live%/*}"
id="\${staged##*/.Zebby-Beta-update-}"
id="\${id%.app}"
if [ "\${live##*/}" != 'Zebby - Beta.app' ] || [ "$staged" != "$parent/.Zebby-Beta-update-$id.app" ] ||
   [ "$backup" != "$parent/.Zebby-Beta-backup-$id.app" ]; then exit 1; fi
count=0
while kill -0 "$pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -ge 180 ]; then printf '%s\\n' 'Zebby - Beta did not close. Update canceled.' >> "$log"; exit 1; fi
  sleep 1
done
if [ ! -d "$live" ] || [ ! -d "$staged" ] || [ -e "$backup" ]; then
  printf '%s\\n' 'The staged update is unavailable. Existing app preserved.' >> "$log"
  exit 1
fi
if ! /bin/mv "$live" "$backup"; then
  printf '%s\\n' 'Could not move the existing app. Update canceled.' >> "$log"
  exit 1
fi
if ! /bin/mv "$staged" "$live"; then
  /bin/mv "$backup" "$live"
  printf '%s\\n' 'Could not install the update. Previous app restored.' >> "$log"
  /usr/bin/open -a "$live"
  exit 1
fi
if ! /usr/bin/open -a "$live"; then
  /bin/mv "$live" "$staged"
  /bin/mv "$backup" "$live"
  printf '%s\\n' 'Could not reopen the update. Previous app restored.' >> "$log"
  /usr/bin/open -a "$live"
  exit 1
fi
`;
}

async function verified(file: string, release: Release) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== release.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === release.sha256;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export class SelfUpdater {
  private prepared: Prepared | null = null;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private release: Release | null = null;
  private readonly options: UpdaterOptions;
  constructor(options: UpdaterOptions) { this.options = options; }

  private report(phase: UpdateState["download"]["phase"], received = 0, total = this.release?.size || 0, error = "") {
    this.options.onChange({ phase, received, total, error });
  }
  download(release: Release) {
    if (this.pending) return this.pending;
    if (this.prepared?.version === release.version && this.release?.installerUrl === release.installerUrl &&
        this.release.sha256 === release.sha256 && this.release.size === release.size) return Promise.resolve();
    this.prepared = null;
    this.release = structuredClone(release);
    this.pending = this.prepare(release).finally(() => { this.pending = null; this.controller = null; });
    return this.pending;
  }
  private async prepare(release: Release) {
    const filename = installerFilename(release.version, this.options.platform, this.options.arch || process.arch);
    if (!/^[\da-f]{64}$/.test(release.sha256) ||
        ![release.version, `v${release.version}`].some(tag => release.installerUrl === `${RELEASE_REPOSITORY}/releases/download/${tag}/${filename}`) ||
        !Number.isSafeInteger(release.size) || release.size <= 0 || release.size > 1024 * 1024 * 1024) {
      throw new Error("The update information is invalid.");
    }
    const folder = path.join(this.options.folder, release.version);
    await mkdir(folder, { recursive: true });
    const installer = path.join(folder, filename);
    const temporary = `${installer}.${randomUUID()}.part`;
    this.report("downloading");
    try {
      if (!(await verified(installer, release))) {
        this.controller = new AbortController();
        const response = await (this.options.fetch || fetch)(release.installerUrl, {
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15 * 60_000)]) });
        if (!response.ok || !response.body) throw new Error("The update download could not be started. Try again.");
        const file = await open(temporary, "wx"), reader = response.body.getReader();
        let received = 0, lastProgress = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > release.size) throw new Error("The update size did not match. Try downloading again.");
            let offset = 0;
            while (offset < value.byteLength) {
              const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
              if (!bytesWritten) throw new Error("The update could not be saved. Check available disk space.");
              offset += bytesWritten;
            }
            if (Date.now() - lastProgress > 150) { this.report("downloading", received); lastProgress = Date.now(); }
          }
          this.report("verifying", received);
        } finally { await reader.cancel().catch(() => undefined); await file.close(); }
        if (!(await verified(temporary, release))) throw new Error("The update could not be verified. Try downloading again.");
        await rename(temporary, installer);
      }
      this.report("verifying", release.size);
      const prepared: Prepared = { version: release.version, installer };
      if (this.options.platform === "darwin") {
        const previous = await this.readPending();
        if (previous?.version === release.version && previous.installer === installer) {
          this.validateMacPaths(previous);
          try { await this.checkMacFiles(previous); Object.assign(prepared, previous); }
          catch {
            await rm(previous.staged!, { recursive: true, force: true });
            await rm(previous.helper!, { force: true });
            await rm(path.join(this.options.folder, "pending.json"), { force: true });
            Object.assign(prepared, await this.prepareMac(folder, installer, release.version));
          }
        } else Object.assign(prepared, await this.prepareMac(folder, installer, release.version));
      }
      else if (this.options.platform !== "win32") throw new Error("Automatic updates are not available for this computer.");
      const pendingFile = path.join(this.options.folder, "pending.json");
      await writeFile(`${pendingFile}.tmp`, JSON.stringify(prepared), "utf8");
      await rename(`${pendingFile}.tmp`, pendingFile);
      this.prepared = prepared;
      this.report("ready", release.size);
    } catch (error) {
      this.report("error", 0, release.size, error instanceof Error ? error.message : "The update could not be prepared. Try again.");
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }
  private async run(file: string, args: string[]) {
    return this.options.run ? this.options.run(file, args) : execute(file, args, { windowsHide: true, timeout: 90_000 });
  }
  private async readPending(): Promise<Prepared | null> {
    try {
      const value = JSON.parse(await readFile(path.join(this.options.folder, "pending.json"), "utf8"));
      if (!value || typeof value !== "object" || typeof value.version !== "string" || typeof value.installer !== "string") {
        throw new Error("The saved update information is invalid.");
      }
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private validateMacPaths(prepared: Prepared) {
    const target = macApplicationPath(this.options.executable), parent = path.dirname(target);
    const id = typeof prepared.staged === "string" ? new RegExp(`^\\.Zebby-Beta-update-(${UUID})\\.app$`).exec(path.basename(prepared.staged))?.[1] : "";
    if (!id || prepared.target !== target || prepared.staged !== path.join(parent, `.Zebby-Beta-update-${id}.app`) ||
        prepared.backup !== path.join(parent, `.Zebby-Beta-backup-${id}.app`) ||
        prepared.installer !== path.join(this.options.folder, prepared.version, installerFilename(prepared.version, "darwin", "arm64")) ||
        prepared.helper !== path.join(this.options.folder, prepared.version, `install-${id}.sh`)) throw new Error("The update recovery path is invalid.");
  }
  private async checkMacFiles(prepared: Prepared) {
    this.validateMacPaths(prepared);
    for (const folder of [prepared.target!, prepared.staged!]) {
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The app update folder is invalid.");
    }
    await access(path.dirname(prepared.target!), constants.W_OK);
    if (await readFile(prepared.helper!, "utf8") !== macUpdateScript()) throw new Error("The update helper could not be verified. Try downloading again.");
    await this.checkBundle(prepared.staged!, prepared.version);
  }
  private async checkBundle(bundle: string, version: string) {
    const info = await lstat(bundle);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The downloaded app folder is invalid.");
    const plist = path.join(bundle, "Contents", "Info.plist");
    const identifier = await this.run("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleIdentifier", plist]);
    const builtVersion = await this.run("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleShortVersionString", plist]);
    if (identifier.stdout.trim() !== "com.desigrit.zebbycore" || builtVersion.stdout.trim() !== version) throw new Error("The downloaded app did not match this update.");
  }
  private async prepareMac(folder: string, installer: string, version: string) {
    const target = macApplicationPath(this.options.executable), id = randomUUID();
    if (!(await lstat(target)).isDirectory() || (await lstat(target)).isSymbolicLink()) throw new Error("The installed app folder is invalid.");
    await access(path.dirname(target), constants.W_OK);
    const staged = path.join(path.dirname(target), `.Zebby-Beta-update-${id}.app`);
    const backup = path.join(path.dirname(target), `.Zebby-Beta-backup-${id}.app`);
    const mount = path.join(folder, `mount-${id}`), helper = path.join(folder, `install-${id}.sh`);
    await mkdir(mount);
    let mounted = false;
    try {
      await this.run("/usr/bin/hdiutil", ["attach", installer, "-nobrowse", "-readonly", "-mountpoint", mount]); mounted = true;
      const bundle = path.join(mount, "Zebby - Beta.app");
      await this.checkBundle(bundle, version);
      await this.run("/usr/bin/ditto", [bundle, staged]);
      await writeFile(helper, macUpdateScript(), { mode: 0o700 });
      return { target, staged, backup, helper };
    } catch (error) { await rm(staged, { recursive: true, force: true }); throw error; }
    finally { if (mounted) await this.run("/usr/bin/hdiutil", ["detach", mount]); await rm(mount, { recursive: true, force: true }); }
  }
  async install() {
    const prepared = this.prepared, release = this.release;
    try {
      if (!prepared || !release || !(await verified(prepared.installer, release))) throw new Error("Download and verify the update before restarting.");
      if (this.options.platform === "darwin") await this.checkMacFiles(prepared);
    } catch (error) {
      this.prepared = null;
      this.report("error", 0, release?.size || 0, error instanceof Error ? error.message : "The update could not be verified. Try downloading again.");
      throw error;
    }
    this.report("installing", release.size);
    const file = this.options.platform === "darwin" ? "/bin/sh" : prepared.installer;
    const args = this.options.platform === "darwin"
      ? [prepared.helper!, String(process.pid), prepared.target!, prepared.staged!, prepared.backup!, path.join(this.options.folder, "update.log")]
      : ["--updated", "/S", "--force-run"];
    try {
      if (this.options.launch) await this.options.launch(file, args);
      else await new Promise<void>((resolve, reject) => {
        const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
      });
    } catch (error) { this.report("ready", release.size, release.size, "The installer could not start. Try again."); throw error; }
  }
  async cancel() { this.controller?.abort(); await this.pending?.catch(() => undefined); }
  async cleanupInstalled(version: string) {
    const prepared = await this.readPending();
    if (!prepared) return;
    if (prepared.version !== version || !isInstallerVersion(version)) return;
    if (prepared.backup && this.options.platform === "darwin") {
      this.validateMacPaths(prepared);
      await rm(prepared.backup, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
    await rm(path.join(this.options.folder, version), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await rm(path.join(this.options.folder, "pending.json"), { force: true });
  }
}
