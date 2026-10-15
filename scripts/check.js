import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

async function check(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) {
      if (!["node_modules", ".local", ".git", "artifacts"].includes(item.name))
        await check(path);
    } else if (item.name.endsWith(".js")) {
      const result = spawnSync(process.execPath, ["--check", path], {
        encoding: "utf8",
      });
      if (result.status !== 0) {
        console.error(result.stderr);
        process.exitCode = 1;
      }
    } else if (item.name.endsWith(".json"))
      JSON.parse(await readFile(path, "utf8"));
  }
}
await check(".");
if (!process.exitCode) console.log("JavaScript syntax and JSON checks passed.");
