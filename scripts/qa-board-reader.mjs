import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import electron from "electron";

// Opt-in live coverage check. No model calls, credentials, or personal databases.
// The test extractor accepts observed, site-specific vacancy links so this check
// measures loading and pagination independently from model quality.
const root = path.resolve("qa-output/boards-reader");
const model = process.env.ZEBBY_QA_BOARD_MODEL || "";
const instructions = process.env.ZEBBY_QA_BOARD_INSTRUCTIONS || "";
if (instructions && !model) throw new Error("Choose a local model to check tracking instructions.");
await mkdir(path.join(root, "profile"), { recursive: true });
const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  "https://slack.com/careers/dept/product",
  "https://jobs.uber.com/en/jobs/?team=Product&countries=United+States",
  "https://www.metacareers.com/jobsearch/?offices[0]=Menlo%20Park%2C%20CA&roles[0]=Full%20time%20employment&q=Product%20Manager",
];
const outfile = path.join(root, "reader.cjs");
await build({ stdin: { resolveDir: process.cwd(), contents: `
  import { app } from 'electron';
  import { writeFile } from 'node:fs/promises';
  import { BoardBrowser } from './desktop/board-browser';
  import { scanBoard } from './desktop/boards-scan';
  import { analyzeWithOllama } from './desktop/ollama';
  import { boardModelContract } from './shared/boards';
  app.setPath('userData', ${JSON.stringify(path.join(root, "profile"))});
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
  let failed = false;
  for (const [index, url] of ${JSON.stringify(urls)}.entries()) {
    const controller = new AbortController(), reader = new BoardBrowser(controller.signal);
    const originalRead = reader.read.bind(reader);
    reader.read = async () => { const page = await originalRead();
      await writeFile(${JSON.stringify(root)} + '/page-' + index + '.json', JSON.stringify(page, null, 2));
      return page;
    };
    try {
      const model = ${JSON.stringify(model)};
      const scan = await scanBoard({ url, reader, instructions: ${JSON.stringify(instructions)}, signal: controller.signal, provider: model ? 'ollama' : 'coverage-test', model: model || 'observed-ids', batchSize: model ? 12 : 40,
        extract: async input => model ? analyzeWithOllama({ baseUrl: 'http://localhost:11434', model,
          ...boardModelContract(input), content: JSON.stringify(input), thinkingLevel: 'off', signal: controller.signal })
          : ({ listingIds: input.candidates.map(candidate => candidate.id), nextControlId: '' }),
        progress: (message, phase) => { if (phase === 'reading') console.log(new URL(url).hostname + ': ' + message); } });
      const matches = scan.jobs.filter(job => job.matches);
      await writeFile(${JSON.stringify(root)} + '/matches-' + index + '.json', JSON.stringify(matches, null, 2));
      console.log(JSON.stringify({ host: new URL(url).hostname, pages: scan.pages, jobs: scan.jobs.length, matches: matches.length, model: model || 'coverage-test', status: 'complete' }));
    } catch (error) { failed = true; console.error(new URL(url).hostname + ': ' + error.message); }
    finally { reader.close(); }
  }
  app.exit(failed ? 1 : 0);
  }).catch(error => { console.error(error); app.exit(1); });
` }, outfile, bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron", "node:*"] });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [outfile], { env, stdio: "inherit", windowsHide: true });
process.exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code || 0)); });
