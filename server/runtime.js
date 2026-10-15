import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  link,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
export const applicationId = "live-interpret";
export const version = "0.2.0";
export function dataDirectory(environment = process.env) {
  return environment.LIVE_INTERPRET_DATA_DIR
    ? resolve(environment.LIVE_INTERPRET_DATA_DIR)
    : join(projectDirectory, ".local");
}

export async function persistentToken(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "auth-token");
  const temporary = join(
    directory,
    `auth-token-${randomBytes(8).toString("hex")}.tmp`,
  );
  await writeFile(temporary, randomBytes(24).toString("hex"), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary);
  }
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{48}$/.test(token))
    throw new Error("本机连接凭据损坏，请检查应用数据目录");
  await chmod(path, 0o600);
  return token;
}
