import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { LiveSession } from "../server/session.js";
import { defaults } from "../server/config.js";

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Condition did not settle");
}

test("stopping during transcription cannot publish a late caption", async () => {
  let release;
  const events = [];
  const session = new LiveSession((type, data) => events.push({ type, data }), {
    transcribe: () => new Promise((resolve) => (release = resolve)),
    translate: async () => assert.fail("Stopped speech must not be translated"),
  });
  const live = session.start(defaults, { kind: "live" });
  session.enqueue(live.id, Buffer.alloc(0), 1);
  session.stop();
  release("old speech");
  await until(() => !session.running);
  assert.equal(events.filter((item) => item.type === "caption").length, 0);
});
test("a new stream cannot receive an old translation, and its context starts empty", async () => {
  let release;
  const events = [];
  let count = 0;
  const session = new LiveSession(
    (type, data) => events.push({ type, data: structuredClone(data) }),
    {
      transcribe: async () => (++count === 1 ? "old stream" : "new stream"),
      translate: async (_config, text, context) => {
        assert.equal(context.length, 0);
        if (text === "old stream")
          return new Promise((resolve) => (release = resolve));
        return "新直播";
      },
    },
  );
  const first = session.start(defaults, { kind: "live" });
  session.enqueue(first.id, Buffer.alloc(0), 1);
  await until(() => Boolean(release));
  const next = session.start(defaults, { kind: "live" });
  session.enqueue(next.id, Buffer.alloc(0), 1);
  release("旧直播");
  await until(() => !session.running);
  const final = events.filter(
    (item) => item.type === "caption" && item.data.status === "final",
  );
  assert.equal(final.length, 1);
  assert.equal(final[0].data.sessionId, next.id);
});
test("backpressure retains only the newest waiting segment and reports the skip", async () => {
  let release;
  const seen = [];
  const session = new LiveSession(() => {}, {
    transcribe: async (_config, value) => {
      seen.push(value);
      if (value === "one") await new Promise((resolve) => (release = resolve));
      return value;
    },
    translate: async (_config, value) => value,
  });
  const live = session.start(defaults, { kind: "live" });
  session.enqueue(live.id, "one", 1);
  session.enqueue(live.id, "two", 1);
  session.enqueue(live.id, "three", 1);
  assert.equal(session.queue.length, 1);
  assert.equal(live.dropped, 1);
  release();
  await until(() => !session.running);
  assert.deepEqual(seen, ["one", "three"]);
});
test("lost browser heartbeat and repeated provider failures stop audio sessions", async () => {
  let now = 0;
  const session = new LiveSession(
    () => {},
    {
      transcribe: async () => {
        throw new Error("upstream down");
      },
      translate: async () => "",
    },
    () => now,
  );
  const live = session.start(defaults, { kind: "live" });
  for (let i = 0; i < 3; i++) {
    session.enqueue(live.id, "", 1);
    await until(() => !session.running);
  }
  assert.equal(live.active, false);
  const next = session.start(defaults, { kind: "live" });
  now = 13000;
  session.checkHeartbeat();
  assert.equal(next.active, false);
  assert.throws(() => session.heartbeat(live.id, 0), /已结束/);
});
