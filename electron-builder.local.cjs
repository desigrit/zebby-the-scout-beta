/* eslint-disable @typescript-eslint/no-require-imports */
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { build } = require("./package.json");

const electronDist = join(__dirname, "node_modules", "electron", "dist");
module.exports = {
  ...build,
  ...(process.arch === "x64" && existsSync(join(electronDist, "electron.exe")) ? { electronDist } : {}),
};
