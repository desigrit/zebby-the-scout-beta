import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";

const root = path.resolve("qa-output/netflix-diagnostic");
await mkdir(root, { recursive: true });
const outfile = path.join(root, "probe.cjs");
await build({ entryPoints: ["scripts/qa-netflix-probe.mjs"], outfile, bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron", "node:*"] });
const env = { ...process.env, NETFLIX_PROFILE: path.join(root, "profile") }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [outfile], { env, stdio: "inherit", windowsHide: true });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
