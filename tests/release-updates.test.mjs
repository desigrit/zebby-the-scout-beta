import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReleaseUpdates, RELEASE_REPOSITORY, newerVersion, updateFromRelease } from "../desktop/release-updates.ts";
import { SelfUpdater, macApplicationPath } from "../desktop/self-update.ts";

const bytes = new TextEncoder().encode("synthetic installer bytes, never executable");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const version = "2.0.0-beta.4";
function releasePayload(tagVersion = version) {
  return { tag_name: `v${tagVersion}`, draft: false, prerelease: tagVersion.includes("-beta."),
    html_url: `${RELEASE_REPOSITORY}/releases/tag/v${tagVersion}`,
    assets: ["win-x64.exe", "win-arm64.exe", "mac-arm64.dmg"].map(suffix => ({ name: `Zebby-Beta-${tagVersion}-${suffix}`,
      browser_download_url: `${RELEASE_REPOSITORY}/releases/download/v${tagVersion}/Zebby-Beta-${tagVersion}-${suffix}`,
      size: bytes.byteLength, state: "uploaded", digest: `sha256:${sha256}` })) };
}
const selected = (platform = "win32", arch = "x64") => updateFromRelease(releasePayload(), "1.5.0", platform, arch);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "zebby-update-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("release selection uses numeric versions and the exact installer for each supported architecture", () => {
  assert.equal(newerVersion("v1.10.0", "1.9.99"), true);
  assert.equal(newerVersion("v2.6.3-beta.10", "2.6.3-beta.9"), true);
  assert.equal(newerVersion("2.6.3", "2.6.3-beta.10"), true);
  assert.equal(newerVersion("2.6.4-beta.1", "2.6.3"), true);
  for (const [next, current] of [["2.6.3-beta.2", "2.6.3-beta.10"], ["2.6.3-beta.9", "2.6.3"], ["2.6.3-beta.04", version], ["1.5.0", "1.5.0"], ["1.4.9", "1.5.0"], ["v2.0.0-beta", "1.5.0"], ["2.0.0", "garbage"]]) {
    assert.equal(newerVersion(next, current), false);
  }
  for (const [platform, arch, suffix] of [["win32", "x64", "win-x64.exe"], ["win32", "arm64", "win-arm64.exe"], ["darwin", "arm64", "mac-arm64.dmg"]]) {
    const release = selected(platform, arch);
    assert.equal(release.installerUrl, `${RELEASE_REPOSITORY}/releases/download/v${version}/Zebby-Beta-${version}-${suffix}`);
    assert.equal(release.sha256, sha256);
    assert.equal(release.size, bytes.byteLength);
  }
  assert.equal(updateFromRelease({ ...releasePayload(), draft: true }, "1.5.0", "win32", "x64"), null);
  assert.equal(updateFromRelease(releasePayload(), version, "win32", "x64"), null);
  assert.equal(updateFromRelease(releasePayload(), "2.1.0", "win32", "x64"), null);
  assert.throws(() => selected("linux", "x64"), /not available/);
});

test("release selection refuses missing verification data, unavailable installers, and substituted hosts", () => {
  for (const change of [{ digest: null }, { digest: "sha256:abc" }, { size: 0 }, { state: "new" },
    { browser_download_url: "https://example.org/installer.exe" }]) {
    const payload = releasePayload(); Object.assign(payload.assets[0], change);
    assert.throws(() => updateFromRelease(payload, "1.5.0", "win32", "x64"), /not available/);
  }
  assert.throws(() => updateFromRelease({ ...releasePayload(), html_url: "https://example.org/release" }, "1.5.0", "win32", "x64"), /not available/);
});

test("checks published beta releases across pages and chooses the newest version regardless of list order", async () => {
  const pages = [[releasePayload("2.6.3-beta.3"), { ...releasePayload("9.0.0"), draft: true }, releasePayload("2.6.3-beta.9")],
    [releasePayload("2.6.3-beta.12"), releasePayload("2.6.3-beta.10"), releasePayload("3.0.0-nightly.1")]];
  const urls = [];
  const checker = new ReleaseUpdates({ version: "2.6.3-beta.3", platform: "win32", arch: "x64", fetch: async url => {
    urls.push(url);
    return Response.json(pages[urls.length - 1], { headers: urls.length === 1 ? { Link: '<https://api.github.com/>; rel="next"' } : {} });
  } });
  const state = await checker.check(true);
  assert.deepEqual(urls, [1, 2].map(page => `https://api.github.com/repos/desigrit/zebby-the-scout-beta/releases?per_page=20&page=${page}`));
  assert.equal(state.error, "");
  assert.equal(state.available.version, "2.6.3-beta.12");
});

test("an empty release list is up to date and an incomplete newer release reports an error", async () => {
  let releases = [];
  const checker = new ReleaseUpdates({ version: "2.0.0-beta.3", platform: "win32", arch: "x64",
    fetch: async () => Response.json(releases) });
  const empty = await checker.check(true);
  assert.equal(empty.available, null);
  assert.equal(empty.error, "");
  assert.ok(empty.checkedAt);
  releases = [releasePayload(), { ...releasePayload("2.0.0-beta.5"), assets: [] }];
  const incomplete = await checker.check(true);
  assert.equal(incomplete.available, null);
  assert.match(incomplete.error, /Try again/);
});

test("update checks coalesce requests, throttle automatic checks, and preserve a prepared update while offline", async () => {
  let now = 0, requests = 0, offline = false, complete;
  const errors = [], changes = [];
  const waiting = new Promise(resolve => { complete = resolve; });
  const checker = new ReleaseUpdates({ version: "1.5.0", platform: "win32", arch: "x64", now: () => now,
    fetch: async () => { requests++; await waiting; if (offline) throw new Error("offline fixture"); return Response.json([releasePayload()]); },
    onChange: value => changes.push(value), onError: error => errors.push(error) });
  const first = checker.check(); assert.equal(checker.check(), first);
  assert.equal(checker.state.checking, true); complete(); await first;
  assert.equal(checker.state.available.version, version);
  await checker.check(); assert.equal(requests, 1);
  now += 6 * 60 * 60 * 1000; offline = true;
  await checker.check(); assert.equal(requests, 2);
  assert.equal(checker.state.available.version, version);
  assert.match(checker.state.error, /Try again/); assert.equal(errors.length, 1);
  checker.setDownload({ phase: "ready", total: bytes.length, received: bytes.length, error: "" });
  await checker.check(true); assert.equal(requests, 2);
  const copy = checker.state; copy.available.version = "bad";
  assert.equal(checker.state.available.version, version);
  assert.ok(changes.length >= 5);
});

test("Windows updates download once, verify, cache, and launch with the silent update flags", async t => {
  const root = await fixture(t), folder = path.join(root, "Updates"), states = [], launches = [];
  await mkdir(path.join(root, "Models"));
  await writeFile(path.join(root, "Applications.sqlite"), "original database");
  await writeFile(path.join(root, "Boards.sqlite"), "saved tracking instructions");
  await writeFile(path.join(root, "Models", "resume-model.gguf"), "original model");
  let requests = 0;
  const options = { folder, platform: "win32", arch: "x64", executable: path.join(root, "Zebby - Beta.exe"),
    fetch: async () => { requests++; return new Response(bytes); }, onChange: state => states.push(state),
    launch: async (file, args) => launches.push({ file, args }) };
  const updater = new SelfUpdater(options);
  const first = updater.download(selected()); assert.equal(updater.download(selected()), first); await first;
  assert.equal(requests, 1); assert.equal(states.at(-1).phase, "ready");
  const installer = path.join(folder, version, `Zebby-Beta-${version}-win-x64.exe`);
  assert.deepEqual(new Uint8Array(await readFile(installer)), bytes);
  await updater.install(); assert.deepEqual(launches, [{ file: installer, args: ["--updated", "/S", "--force-run"] }]);
  await new SelfUpdater(options).download(selected()); assert.equal(requests, 1);
  await updater.cleanupInstalled("1.5.0"); assert.ok((await readdir(folder)).includes("pending.json"));
  await updater.cleanupInstalled(version); assert.deepEqual(await readdir(folder), []);
  assert.equal(await readFile(path.join(root, "Applications.sqlite"), "utf8"), "original database");
  assert.equal(await readFile(path.join(root, "Boards.sqlite"), "utf8"), "saved tracking instructions");
  assert.equal(await readFile(path.join(root, "Models", "resume-model.gguf"), "utf8"), "original model");
});

test("failed downloads cannot launch and remove partial files; a verified installer is checked again before restart", async t => {
  const root = await fixture(t);
  for (const [name, response] of [["hash", new Response(new Uint8Array(bytes.length))], ["truncated", new Response(bytes.slice(0, 5))],
    ["oversized", new Response(new Uint8Array(bytes.length + 1))], ["http", new Response("unavailable", { status: 503 })]]) {
    const folder = path.join(root, name), states = []; let launched = false;
    const updater = new SelfUpdater({ folder, platform: "win32", arch: "x64", executable: "unused",
      fetch: async () => response, onChange: state => states.push(state), launch: async () => { launched = true; } });
    await assert.rejects(updater.download(selected()));
    assert.equal(states.at(-1).phase, "error");
    assert.equal((await readdir(path.join(folder, version))).some(file => file.endsWith(".part")), false);
    await assert.rejects(updater.install(), /verify/); assert.equal(launched, false);
  }
  const folder = path.join(root, "tampered"), states = [];
  const updater = new SelfUpdater({ folder, platform: "win32", arch: "x64", executable: "unused",
    fetch: async () => new Response(bytes), onChange: state => states.push(state), launch: async () => assert.fail("must not launch") });
  await updater.download(selected());
  await writeFile(path.join(folder, version, `Zebby-Beta-${version}-win-x64.exe`), new Uint8Array(bytes.length));
  await assert.rejects(updater.install(), /verify/); assert.equal(states.at(-1).phase, "error");
  await updater.download(selected()); assert.equal(states.at(-1).phase, "ready");
});

test("Mac updates verify bundle identity, retain a staged download across relaunch, and bound recovery cleanup", async t => {
  const root = await fixture(t), applications = path.join(root, "Applications"), folder = path.join(root, "Updates");
  const executable = path.join(applications, "Zebby - Beta.app", "Contents", "MacOS", "Zebby - Beta");
  await mkdir(path.dirname(executable), { recursive: true });
  let identifier = "com.desigrit.zebbycore", attaches = 0, launches = [];
  const options = { folder, platform: "darwin", arch: "arm64", executable, fetch: async () => new Response(bytes), onChange: () => {},
    run: async (file, args) => {
      if (file.endsWith("hdiutil") && args[0] === "attach") { attaches++; await mkdir(path.join(args.at(-1), "Zebby - Beta.app", "Contents"), { recursive: true }); }
      if (file.endsWith("ditto")) await cp(args[0], args[1], { recursive: true });
      return { stdout: file.endsWith("PlistBuddy") ? (args[1].includes("Identifier") ? identifier : version) : "" };
    }, launch: async (file, args) => launches.push({ file, args }) };
  const updater = new SelfUpdater(options);
  await updater.download(selected("darwin", "arm64")); assert.equal(attaches, 1);
  const pending = JSON.parse(await readFile(path.join(folder, "pending.json"), "utf8"));
  await new SelfUpdater(options).download(selected("darwin", "arm64")); assert.equal(attaches, 1);
  await updater.install(); assert.equal(launches[0].file, "/bin/sh");
  assert.deepEqual(launches[0].args.slice(2, 5), [pending.target, pending.staged, pending.backup]);
  await mkdir(pending.backup); await writeFile(path.join(pending.backup, "old-app"), "recovery");
  const outside = path.join(root, "unrelated"); await mkdir(outside); await writeFile(path.join(outside, "keep"), "keep");
  await writeFile(path.join(folder, "pending.json"), JSON.stringify({ ...pending, backup: outside }));
  await assert.rejects(updater.cleanupInstalled(version), /recovery path/);
  assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "keep");
  await writeFile(path.join(folder, "pending.json"), JSON.stringify(pending));
  await updater.cleanupInstalled(version); await assert.rejects(readFile(path.join(pending.backup, "old-app")), { code: "ENOENT" });
  identifier = "unexpected.app";
  await assert.rejects(new SelfUpdater(options).download(selected("darwin", "arm64")), /did not match/);
  assert.equal((await readdir(applications)).filter(name => name.startsWith(".Zebby-Beta-update-")).length, 1);
  assert.throws(() => macApplicationPath("/Volumes/Zebby/Zebby - Beta.app/Contents/MacOS/Zebby"), /Install Zebby/);
});

test("installer URLs and malformed pending data cannot select arbitrary executables or cleanup folders", async t => {
  const root = await fixture(t), updater = new SelfUpdater({ folder: root, platform: "win32", arch: "x64", executable: "unused",
    fetch: async () => assert.fail("invalid download must not run"), onChange: () => {} });
  await assert.rejects(updater.download({ ...selected(), installerUrl: `${selected().installerUrl}?redirect=bad` }), /invalid/);
  await assert.rejects(updater.download({ ...selected(), installerUrl: selected().installerUrl.replace("zebby-the-scout-beta/", "zebby-the-scout/") }), /invalid/);
  await assert.rejects(updater.download({ ...selected(), version: "../2.0.0" }), /invalid/);
  await writeFile(path.join(root, "pending.json"), "null");
  await assert.rejects(updater.cleanupInstalled(version), /invalid/);
});
