import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "../server/index.js";
import { encodeWav } from "../extension/lib/audio.js";
import { readEvents } from "../extension/lib/events.js";

test("real HTTP chain authenticates, protects keys, uploads WAV, and publishes translated subtitles", async (t) => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.push({ path: request.url, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/audio/transcriptions") {
      const form = await new Request("http://local", {
        method: "POST",
        headers: request.headers,
        body,
      }).formData();
      assert.equal(form.get("model"), "test-asr");
      assert.equal(form.get("language"), "ja");
      const audio = Buffer.from(await form.get("file").arrayBuffer());
      assert.equal(audio.toString("ascii", 0, 4), "RIFF");
      response.end(JSON.stringify({ text: "みんな、ありがとう！" }));
    } else {
      const input = JSON.parse(body);
      assert.equal(input.model, "test-translation");
      assert.equal(input.messages.at(-1).content, "みんな、ありがとう！");
      assert.match(input.messages[0].content, /推し=最喜欢的主播/);
      response.end(
        JSON.stringify({ choices: [{ message: { content: "谢谢大家！" } }] }),
      );
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const directory = await mkdtemp(join(tmpdir(), "live-interpret-test-"));
  const app = await createApplication({ directory });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const providerBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  const headers = {
    Authorization: `Bearer ${app.token}`,
    "Content-Type": "application/json",
  };
  const request = (path, body, method = "POST") =>
    fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/config`, {
        headers: { ...headers, Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  const saved = await (
    await request(
      "/api/config",
      {
        asr: {
          baseUrl: providerBase,
          model: "test-asr",
          apiKey: "test-secret-a",
        },
        translation: {
          baseUrl: providerBase,
          model: "test-translation",
          apiKey: "test-secret-b",
        },
        glossary: "推し=最喜欢的主播",
      },
      "PUT",
    )
  ).json();
  assert.equal(saved.ready, true);
  assert.equal(saved.asr.hasKey, true);
  assert.ok(!JSON.stringify(saved).includes("test-secret"));
  await request(
    "/api/config",
    {
      appearance: { fontSize: 35, bottom: 10, opacity: 80, showOriginal: true },
      asr: { apiKey: "" },
    },
    "PUT",
  );
  const disk = JSON.parse(
    await readFile(join(directory, "config.json"), "utf8"),
  );
  assert.equal(disk.asr.apiKey, "test-secret-a");
  assert.equal(
    (await stat(join(directory, "config.json"))).mode & 0o777,
    0o600,
  );
  const events = [];
  const response = await fetch(`${base}/api/events`, {
    headers,
    signal: controller.signal,
  });
  const reading = readEvents(response, (value) => events.push(value)).catch(
    () => {},
  );
  const live = await (
    await request("/api/session", {
      source: {
        url: "https://www.youtube.com/watch?v=test",
        title: "Test live",
      },
    })
  ).json();
  const audio = encodeWav(new Float32Array(16000).fill(0.1));
  assert.equal(
    (
      await fetch(`${base}/api/audio?session=${live.id}`, {
        method: "POST",
        headers: {
          Authorization: headers.Authorization,
          "Content-Type": "audio/wav",
        },
        body: audio,
      })
    ).status,
    202,
  );
  for (
    let i = 0;
    i < 200 &&
    !events.some(
      (value) => value.type === "caption" && value.data.status === "final",
    );
    i++
  )
    await delay(10);
  const final = events.find(
    (value) => value.type === "caption" && value.data.status === "final",
  );
  assert.equal(final?.data.translation, "谢谢大家！");
  assert.equal(received[0].headers.authorization, "Bearer test-secret-a");
  assert.equal(received[1].headers.authorization, "Bearer test-secret-b");
  assert.ok(!JSON.stringify(events).includes("test-secret"));
  assert.equal(
    (
      await request("/api/session", {
        source: { url: "https://attacker.example", title: "bad" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/api/audio?session=${live.id}`, {
        method: "POST",
        headers,
        body: "bad audio",
      })
    ).status,
    400,
  );
  await request("/api/stop", { id: live.id });
  assert.equal(
    (
      await fetch(`${base}/api/audio?session=${live.id}`, {
        method: "POST",
        headers,
        body: audio,
      })
    ).status,
    409,
  );
  await request("/api/config", { asr: { apiKey: null } }, "PUT");
  assert.equal(app.store.value.asr.apiKey, "");
  controller.abort();
  await reading;
});

test("SSE parser handles split UTF-8 and several events in one chunk", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"type":"caption","data":"字幕"}\n\n: heartbeat\n\ndata: {"type":"end"}\n\n',
  );
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const events = [];
  await readEvents(new Response(stream), (event) => events.push(event));
  assert.deepEqual(events, [
    { type: "caption", data: "字幕" },
    { type: "end" },
  ]);
});
