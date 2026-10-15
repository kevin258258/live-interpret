import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { projectDirectory } from "./runtime.js";

// Desktop Entry values are decoded once, then the Exec argument quoting is decoded.
function value(text) {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}
function argument(text) {
  if (/[\n\r\0]/.test(text)) throw new Error("启动路径不能包含换行或空字符");
  return value(`"${text.replaceAll("%", "%%").replace(/[\\"`$]/g, "\\$&")}"`);
}
export function desktopEntry({
  project = projectDirectory,
  executable = process.execPath,
} = {}) {
  if (!isAbsolute(project) || !isAbsolute(executable))
    throw new Error("启动器需要完整路径");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Live Interpret",
    "Name[zh_CN]=Live Interpret 直播字幕",
    "Comment=Live subtitles, in your language",
    "Comment[zh_CN]=打开直播字幕面板，保留原声，读懂现场",
    `Exec=${argument(executable)} ${argument(join(project, "scripts/launch.js"))}`,
    `Icon=${value(join(project, "web/mark.svg"))}`,
    "Terminal=false",
    "StartupNotify=false",
    "Categories=AudioVideo;",
    "Keywords=subtitles;translation;直播;字幕;",
    "X-LiveInterpret-Managed=true",
    "",
  ].join("\n");
}
export function createDesktopIntegration({
  directory,
  project = projectDirectory,
  executable = process.execPath,
} = {}) {
  const dataHome = process.env.XDG_DATA_HOME;
  const applications =
    directory ??
    join(
      dataHome && isAbsolute(dataHome)
        ? dataHome
        : join(homedir(), ".local/share"),
      "applications",
    );
  const path = join(applications, "live-interpret.desktop");
  const expected = desktopEntry({ project, executable });
  return {
    async status() {
      try {
        return {
          supported: process.platform === "linux",
          installed: (await readFile(path, "utf8")) === expected,
        };
      } catch {
        return { supported: process.platform === "linux", installed: false };
      }
    },
    async install() {
      if (process.platform !== "linux")
        throw new Error("当前启动入口仅支持 Linux 桌面");
      try {
        const existing = await readFile(path, "utf8");
        if (!existing.includes("X-LiveInterpret-Managed=true"))
          throw new Error(
            "已有同名应用入口，未覆盖。请先检查应用菜单中的 Live Interpret。",
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await access(executable, constants.X_OK);
      await access(join(project, "scripts/launch.js"));
      await mkdir(applications, { recursive: true });
      await writeFile(path, expected, { mode: 0o644 });
      return { installed: true, name: "Live Interpret", path };
    },
  };
}
