import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApplication } from "../server/index.js";
import { encodeWav } from "../extension/lib/audio.js";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const directory = await mkdtemp(join(tmpdir(), "live-interpret-browser-"));
const upstream = createServer(async (request, response) => {
  for await (const _chunk of request) {
    /* Drain test request. Never contact a real provider. */
  }
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify(
      request.url.includes("audio/transcriptions")
        ? {
            text: "みんな、来てくれてありがとう！今日は新しいゲームをやってみよう。",
          }
        : {
            choices: [
              {
                message: {
                  content: "谢谢大家来看直播！今天来试试一个新游戏。",
                },
              },
            ],
          },
    ),
  );
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const app = await createApplication({ directory });
app.server.listen(0, "127.0.0.1");
await once(app.server, "listening");
const base = `http://127.0.0.1:${app.server.address().port}`;
const provider = `http://127.0.0.1:${upstream.address().port}/v1`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir(resolve("artifacts"), { recursive: true });
try {
  await page.goto(`${base}/#${app.token}`);
  await page.getByText("本机服务已连接", { exact: false }).waitFor();
  await page.screenshot({
    path: "artifacts/workspace-initial.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "配置 API" }).click();
  for (const kind of ["asr", "translation"]) {
    await page.locator(`#${kind}-base`).fill(provider);
    await page.locator(`#${kind}-model`).fill(`test-${kind}`);
    await page.locator(`#${kind}-key`).fill(`test-secret-${kind}`);
  }
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.waitForFunction(
    () => document.getElementById("asr-state").textContent === "test-asr",
  );
  assert.ok(!(await page.locator("body").innerText()).includes("test-secret"));
  await page.getByRole("button", { name: "体验字幕示例" }).click();
  await page.locator("#mode-badge").filter({ hasText: "体验示例" }).waitFor();
  await page
    .locator("#preview-translation")
    .filter({ hasText: "谢谢大家" })
    .waitFor();
  await page.evaluate(() => {
    const input = document.getElementById("font-size");
    input.value = 36;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(
    () => document.getElementById("font-size-value").value === "36 px",
  );
  await page.waitForTimeout(450);
  await page.screenshot({
    path: "artifacts/workspace-demo.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "个人术语表" }).click();
  await page.locator("#glossary").fill("配信 = 直播\n推し = 最喜欢的主播");
  await page.getByRole("button", { name: "保存术语表" }).click();
  await page.waitForFunction(
    () => document.getElementById("glossary-count").textContent === "2",
  );
  await page.getByRole("button", { name: "字幕工作台", exact: false }).click();
  await page.getByRole("button", { name: "连接浏览器扩展" }).click();
  await page.locator("#connect-dialog").waitFor({ state: "visible" });
  assert.match(
    await page.locator("#extension-path").textContent(),
    /live-interpret\/extension$/,
  );
  await page.getByRole("button", { name: "关闭连接说明" }).click();
  const headers = {
    Authorization: `Bearer ${app.token}`,
    "Content-Type": "application/json",
  };
  const live = await (
    await fetch(`${base}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: {
          url: "https://www.youtube.com/watch?v=synthetic-test",
          title: "YouTube · 模拟音源集成测试",
        },
      }),
    })
  ).json();
  await fetch(`${base}/api/audio?session=${live.id}`, {
    method: "POST",
    headers: {
      Authorization: headers.Authorization,
      "Content-Type": "audio/wav",
    },
    body: encodeWav(new Float32Array(16000).fill(0.1)),
  });
  await page.waitForFunction(
    () =>
      document
        .getElementById("preview-translation")
        .textContent.includes("谢谢大家") &&
      document.getElementById("mode-badge").textContent === "正在同传",
  );
  assert.equal(await page.locator("#caption-count").textContent(), "1");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出文本" }).click();
  const download = await downloadPromise;
  assert.ok(download.suggestedFilename().endsWith(".txt"));
  await page.getByRole("button", { name: "停止同传" }).click();
  await page.locator("#mode-badge").filter({ hasText: "等待连接" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "artifacts/workspace-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Narrow viewport should not overflow horizontally",
  );

  // Exercise the production overlay against a deterministic player DOM. This does not claim tabCapture passed.
  const overlayPage = await context.newPage();
  overlayPage.on("pageerror", (error) => errors.push(error.message));
  await overlayPage.addInitScript(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadow = original.call(this, options);
      window.__overlayShadow = shadow;
      return shadow;
    };
    window.chrome = {
      runtime: {
        onMessage: { addListener: (listener) => (window.__deliver = listener) },
        sendMessage: async () => ({}),
      },
    };
  });
  await overlayPage.route("https://www.youtube.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><html><head><title>Synthetic player fixture</title></head><body style="margin:0;background:#17211c;color:white;font:24px system-ui"><main id="player" style="position:relative;margin:60px;width:1000px;height:560px;background:#24352d"><video style="width:100%;height:100%"></video><button id="full" style="position:absolute;top:20px;left:20px" onclick="document.getElementById(\'player\').requestFullscreen()">Fullscreen</button><span style="position:absolute;top:80px;left:30px;font-size:16px;color:#a4b9ab">YouTube / Twitch · 合成播放器测试画面</span></main></body></html>',
    }),
  );
  await overlayPage.goto("https://www.youtube.com/watch?v=fixture");
  await overlayPage.addScriptTag({
    content: await readFile(
      new URL("../extension/overlay.js", import.meta.url),
      "utf8",
    ),
  });
  await overlayPage.evaluate(() => {
    window.__deliver({
      type: "live-interpret",
      event: {
        type: "started",
        data: {
          appearance: {
            fontSize: 34,
            bottom: 9,
            opacity: 78,
            showOriginal: true,
          },
        },
      },
    });
    window.__deliver({
      type: "live-interpret",
      event: {
        type: "caption",
        data: {
          id: "test",
          original: "Chat, did you see that? I actually made that jump!",
          translation: "大家看到了吗？我居然真的跳过去了！",
          status: "final",
        },
      },
    });
  });
  assert.equal(
    await overlayPage.evaluate(
      () => window.__overlayShadow.querySelector(".translation").textContent,
    ),
    "大家看到了吗？我居然真的跳过去了！",
  );
  await overlayPage.locator("#full").click();
  await overlayPage.waitForFunction(
    () => document.fullscreenElement?.id === "player",
  );
  await overlayPage.waitForFunction(
    () =>
      document.getElementById("live-interpret-subtitles").parentElement.id ===
      "player",
  );
  assert.equal(
    await overlayPage
      .locator("#live-interpret-subtitles")
      .evaluate((element) => element.parentElement.id),
    "player",
  );
  await overlayPage.screenshot({ path: "artifacts/player-fullscreen.png" });
  await overlayPage.evaluate(() => {
    window.__deliver({
      type: "live-interpret",
      event: {
        type: "caption",
        data: {
          id: "injection",
          original: '<img src=x onerror="window.injected=true">',
          translation: "<script>window.injected=true</script>",
          status: "final",
        },
      },
    });
  });
  assert.equal(await overlayPage.evaluate(() => window.injected), undefined);
  assert.equal(
    await overlayPage.evaluate(
      () => window.__overlayShadow.querySelectorAll("img,script").length,
    ),
    0,
  );
  await overlayPage.evaluate(() =>
    window.__deliver({ type: "live-interpret-toggle" }),
  );
  assert.equal(
    await overlayPage
      .locator("#live-interpret-subtitles")
      .evaluate((element) => element.style.display),
    "none",
  );
  await overlayPage.evaluate(() =>
    window.__deliver({ type: "live-interpret", event: { type: "stopped" } }),
  );
  assert.equal(
    await overlayPage.evaluate(
      () => window.__overlayShadow.querySelector(".translation").textContent,
    ),
    "",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: setup, demo, live API fixture, styles, glossary, export, narrow layout, fullscreen overlay, text injection, and stop.",
  );
  console.log(
    "Screenshots saved under artifacts/. Actual tabCapture and real providers still need a desktop smoke test.",
  );
} finally {
  await context.close();
  await browser.close();
  await app.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
  await rm(directory, { recursive: true, force: true });
}
