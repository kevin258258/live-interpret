#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, rmdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  applicationId,
  dataDirectory,
  projectDirectory,
} from "../server/runtime.js";
import { createDesktopIntegration } from "../server/desktop.js";

export async function existingConnection(directory, port) {
  try {
    const { url } = JSON.parse(
      await readFile(join(directory, "connection.json"), "utf8"),
    );
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      Number(parsed.port) !== port ||
      !/^[a-f0-9]{48}$/.test(parsed.hash.slice(1))
    )
      return null;
    const response = await fetch(`${parsed.origin}/api/info`, {
      headers: { Authorization: `Bearer ${parsed.hash.slice(1)}` },
      signal: AbortSignal.timeout(600),
    });
    if (!response.ok) return null;
    const info = await response.json();
    if (info.application !== applicationId || !Number.isInteger(info.pid))
      return null;
    return { url, pid: info.pid };
  } catch {
    return null;
  }
}
async function findExecutable(names) {
  for (const name of names)
    for (const directory of (process.env.PATH || "/usr/bin:/bin").split(
      delimiter,
    )) {
      const path = join(directory, name);
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        /* Try the next desktop command. */
      }
    }
  return null;
}
async function openPanel(url) {
  const browser = await findExecutable([
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
  ]);
  const command = browser || (await findExecutable(["xdg-open"]));
  if (!command)
    throw new Error("没有找到浏览器，请安装 Chrome 或 Chromium 后重新启动");
  await new Promise((resolveSpawn, reject) => {
    const child = spawn(command, browser ? [`--app=${url}`] : [url], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
}

export async function launchApplication({
  directory = dataDirectory(),
  port = Number(process.env.PORT ?? 43821),
  openBrowser = true,
  timeoutMs = 10000,
} = {}) {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("请先安装 Node.js 22 或更新版本，再重新打开应用");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("应用端口应为 1024 到 65535 的整数");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let connection = await existingConnection(directory, port);
  let reused = Boolean(connection);
  if (!connection) {
    const lock = join(directory, "launcher.lock");
    const started = Date.now();
    let ownsLock = false;
    while (!ownsLock) {
      try {
        await mkdir(lock);
        ownsLock = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        connection = await existingConnection(directory, port);
        if (connection) {
          reused = true;
          break;
        }
        try {
          if (Date.now() - (await stat(lock)).mtimeMs > 30000) {
            await rmdir(lock);
            continue;
          }
        } catch {
          /* Another launcher may have released its lock. */
        }
        if (Date.now() - started > timeoutMs)
          throw new Error("应用正在启动，请稍后再试");
        await delay(100);
      }
    }
    if (ownsLock) {
      try {
        connection = await existingConnection(directory, port);
        if (connection) reused = true;
        else {
          const log = await open(join(directory, "service.log"), "a", 0o600);
          const child = spawn(
            process.execPath,
            [join(projectDirectory, "server/index.js")],
            {
              cwd: projectDirectory,
              detached: true,
              stdio: ["ignore", log.fd, log.fd],
              env: {
                ...process.env,
                PORT: String(port),
                LIVE_INTERPRET_DATA_DIR: directory,
              },
            },
          );
          let failure;
          child.once("error", (error) => (failure = error));
          child.once("exit", (code) => {
            if (code)
              failure = new Error("本机服务无法启动，端口可能被其他程序占用");
          });
          child.unref();
          await log.close();
          while (!(connection = await existingConnection(directory, port))) {
            if (failure) throw failure;
            if (Date.now() - started > timeoutMs)
              throw new Error(
                "启动未能完成，请稍后重试。诊断信息保存在应用数据目录的 service.log。",
              );
            await delay(100);
          }
        }
      } finally {
        await rmdir(lock).catch(() => {});
      }
    }
  }
  if (openBrowser) await openPanel(connection.url);
  return { ...connection, reused };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.includes("--install")) {
      const result = await createDesktopIntegration().install();
      console.log(`已添加到应用菜单：${result.name}`);
    } else {
      await launchApplication({
        openBrowser: !process.argv.includes("--no-open"),
      });
      console.log("Live Interpret 已就绪。");
    }
  } catch (error) {
    console.error(error.message);
    if (!process.argv.includes("--no-open")) {
      const dialog = await findExecutable(["zenity"]);
      if (dialog) {
        const child = spawn(
          dialog,
          ["--error", "--title=Live Interpret", `--text=${error.message}`],
          { detached: true, stdio: "ignore" },
        );
        child.on("error", () => {});
        child.unref();
      }
    }
    process.exitCode = 1;
  }
}
