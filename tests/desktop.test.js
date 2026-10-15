import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { persistentToken } from "../server/runtime.js";
import { createDesktopIntegration, desktopEntry } from "../server/desktop.js";
import { createApplication } from "../server/index.js";
import { launchApplication, existingConnection } from "../scripts/launch.js";

test("persistent pairing survives restarts and simultaneous initialization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-interpret-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokens = await Promise.all(
    Array.from({ length: 8 }, () => persistentToken(directory)),
  );
  assert.equal(new Set(tokens).size, 1);
  assert.match(tokens[0], /^[a-f0-9]{48}$/);
  assert.equal((await stat(join(directory, "auth-token"))).mode & 0o777, 0o600);
  await writeFile(join(directory, "auth-token"), "invalid");
  await assert.rejects(persistentToken(directory), /凭据损坏/);
});

test("GUI installation is authenticated, idempotent, and preserves unrelated launchers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-interpret-desktop-"));
  const desktop = createDesktopIntegration({
    directory: join(directory, "applications"),
  });
  let quit = false;
  const app = await createApplication({
    directory: join(directory, "data"),
    desktop,
    onShutdown: async () => {
      quit = true;
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${app.token}` };
  assert.equal(
    (await fetch(`${base}/api/desktop/install`, { method: "POST" })).status,
    401,
  );
  const result = await (
    await fetch(`${base}/api/desktop/install`, { method: "POST", headers })
  ).json();
  assert.equal(result.installed, true);
  const entry = await readFile(result.path, "utf8");
  assert.match(entry, /Terminal=false/);
  assert.match(entry, /scripts\/launch\.js/);
  const validation = spawnSync("desktop-file-validate", [result.path], {
    encoding: "utf8",
  });
  if (validation.error?.code !== "ENOENT")
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  assert.equal((await desktop.status()).installed, true);
  await desktop.install();
  assert.equal(await readFile(result.path, "utf8"), entry);
  await writeFile(result.path, "[Desktop Entry]\nName=Existing user app\n");
  await assert.rejects(desktop.install(), /未覆盖/);
  assert.match(await readFile(result.path, "utf8"), /Existing user app/);
  await fetch(`${base}/api/shutdown`, { method: "POST", headers });
  await delay(160);
  assert.equal(quit, true);
  assert.throws(
    () => desktopEntry({ project: "/tmp/invalid\nname" }),
    /启动路径/,
  );
  const escaped = desktopEntry({
    project: '/tmp/space and $dollar "quote" 100%',
  });
  assert.match(escaped, /100%%/);
  assert.match(escaped, /\\\\\$/);
});

test("double launch reuses one background service and a GUI restart preserves settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-interpret-launch-"));
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  let connection;
  const stop = async () => {
    if (!connection) return;
    const url = new URL(connection.url);
    await fetch(`${url.origin}/api/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
    }).catch(() => {});
    for (let i = 0; i < 40 && (await existingConnection(directory, port)); i++)
      await delay(50);
  };
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const launches = await Promise.all([
    launchApplication({ directory, port, openBrowser: false }),
    launchApplication({ directory, port, openBrowser: false }),
  ]);
  connection = launches[0];
  assert.equal(launches[0].pid, launches[1].pid);
  assert.equal(launches.filter((item) => item.reused).length, 1);
  const url = new URL(connection.url);
  const headers = {
    Authorization: `Bearer ${url.hash.slice(1)}`,
    "Content-Type": "application/json",
  };
  await fetch(`${url.origin}/api/config`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ language: "en", glossary: "stream=直播" }),
  });
  await stop();
  assert.equal(await existingConnection(directory, port), null);
  const restarted = await launchApplication({
    directory,
    port,
    openBrowser: false,
  });
  assert.equal(restarted.url, connection.url);
  assert.notEqual(restarted.pid, connection.pid);
  connection = restarted;
  const config = await (
    await fetch(`${url.origin}/api/config`, { headers })
  ).json();
  assert.equal(config.language, "en");
  assert.equal(config.glossary, "stream=直播");
});
