import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApplication } from "../server/index.js";
import { validateWav } from "../server/providers.js";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const directory = await mkdtemp(join(tmpdir(), "live-interpret-extension-"));
let transcriptionCount = 0;
let receivedEnergy = 0;
const app = await createApplication({
  directory: join(directory, "data"),
  providers: {
    async transcribe(_config, wav) {
      validateWav(wav);
      transcriptionCount++;
      for (let i = 44; i < wav.length; i += 2)
        receivedEnergy = Math.max(receivedEnergy, Math.abs(wav.readInt16LE(i)));
      return "This is a synthetic audio capture test.";
    },
    async translate() {
      return "这是通过真实标签页采集的合成音源测试。";
    },
  },
});
await app.store.save({
  asr: { baseUrl: "http://127.0.0.1/v1", model: "fixture" },
  translation: { baseUrl: "http://127.0.0.1/v1", model: "fixture" },
  profile: "fast",
});
app.server.listen(0, "127.0.0.1");
await once(app.server, "listening");
const base = `http://127.0.0.1:${app.server.address().port}`;
const extension = resolve("extension");
const context = await chromium.launchPersistentContext(
  join(directory, "profile"),
  {
    headless: true,
    ignoreDefaultArgs: ["--mute-audio"],
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : { channel: "chromium" }),
    args: [
      "--no-sandbox",
      "--enable-unsafe-extension-debugging",
      "--autoplay-policy=no-user-gesture-required",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
    viewport: { width: 1280, height: 800 },
  },
);
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  console.log("Extension service worker loaded.");
  await worker.evaluate((pairing) => chrome.storage.local.set({ pairing }), {
    base,
    token: app.token,
  });
  await context.route("https://www.youtube.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><title>Synthetic audio fixture</title></head><body style="margin:0;background:#14201a;color:#dcea8c;font-family:system-ui"><main id="player" style="margin:40px;width:1100px;height:620px;background:#263e30;position:relative"><video style="width:100%;height:100%"></video><div style="position:absolute;top:40px;left:40px"><h1>数字音频采集测试</h1><p>合成音源 · 没有连接真实直播或付费模型</p><button id="tone">播放合成音源</button></div></main><script>document.getElementById('tone').onclick=()=>{window.audio=new AudioContext();window.tone=audio.createOscillator();let gain=audio.createGain();gain.gain.value=.09;tone.frequency.value=330;tone.connect(gain).connect(audio.destination);tone.start();audio.resume();};</script></body></html>`,
    }),
  );
  const player = await context.newPage();
  await player.goto("https://www.youtube.com/watch?v=synthetic-capture");
  for (const other of context.pages())
    if (other !== player) await other.close();
  await player.locator("#tone").click();
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send("Target.getTargets", {
    filter: [{ type: "tab", exclude: false }],
  });
  assert.equal(
    targetInfos.length,
    1,
    "The isolated browser should have exactly one tab",
  );
  await browserCdp.send("Extensions.triggerAction", {
    id,
    targetId: targetInfos[0].targetId,
  });
  // Toolbar popups are not exposed as Playwright Pages in headless Chromium.
  // The action above grants activeTab normally; use the same popup document in a tab for controls.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForLoadState();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((tab) =>
        tab.url?.includes("synthetic-capture"),
      ).id,
  );
  await player.bringToFront();
  console.log("Toolbar active-tab permission granted.");
  const startResult = await popup.evaluate(
    (tabId) =>
      chrome.runtime.sendMessage({
        target: "background",
        type: "start",
        tabId,
      }),
    tabId,
  );
  assert.ok(!startResult.error, startResult.error);
  console.log("Offscreen capture started.");
  for (let i = 0; i < 100 && !app.sessions.current?.completed; i++)
    await player.waitForTimeout(100);
  const diagnostics = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ target: "background", type: "status" }),
  );
  console.log(
    "Capture diagnostics:",
    JSON.stringify(diagnostics),
    "source state:",
    await player.evaluate(() => window.audio.state),
  );
  assert.ok(
    transcriptionCount > 0,
    "Real tab audio should reach the transcription stage",
  );
  assert.ok(
    receivedEnergy > 500,
    `Captured audio should be non-silent; peak=${receivedEnergy}`,
  );
  assert.ok(
    app.sessions.current.completed > 0,
    "Captured audio should produce a translated caption",
  );
  assert.equal(
    await player
      .locator("#live-interpret-subtitles")
      .evaluate((element) => element.style.display),
    "block",
  );
  await mkdir("artifacts", { recursive: true });
  await player.screenshot({ path: "artifacts/extension-real-capture.png" });
  await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${app.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      appearance: { fontSize: 40, bottom: 12, opacity: 70, showOriginal: true },
    }),
  });
  await player.waitForFunction(
    () =>
      document
        .getElementById("live-interpret-subtitles")
        .style.getPropertyValue("--size") === "40px",
  );
  await popup.evaluate(() =>
    chrome.runtime.sendMessage({ target: "background", type: "stop" }),
  );
  await player.waitForFunction(
    () =>
      document.getElementById("live-interpret-subtitles").style.display ===
      "none",
  );
  assert.equal(app.sessions.current.active, false);
  const status = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ target: "background", type: "status" }),
  );
  assert.equal(status.active, false);
  console.log(
    `Extension check passed: toolbar action, offscreen tabCapture, non-silent WAV (peak ${receivedEnergy}), translated caption, and explicit stop.`,
  );
  console.log(
    "Audio was synthesized in an intercepted player page; ASR/translation were local fixtures. Real livestreams/providers remain untested.",
  );
} finally {
  await context.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
