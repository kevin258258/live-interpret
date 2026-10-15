import { randomUUID } from "node:crypto";
import { transcribe, translate } from "./providers.js";

const demoLines = [
  [
    "みんな、来てくれてありがとう！今日は新しいゲームをやってみよう。",
    "谢谢大家来看直播！今天来试试一个新游戏。",
  ],
  [
    "え、ちょっと待って。ここの景色、めちゃくちゃきれいじゃない？",
    "诶，等一下。这里的风景也太好看了吧？",
  ],
  [
    "Chat, did you see that? I actually made that jump!",
    "大家看到了吗？我居然真的跳过去了！",
  ],
  [
    "Okay, one more try. This time we are definitely going to win.",
    "好，再来一次。这次我们一定能赢。",
  ],
];

export class LiveSession {
  constructor(emit, providers = { transcribe, translate }, now = Date.now) {
    this.emit = emit;
    this.providers = providers;
    this.now = now;
    this.current = null;
    this.captions = [];
    this.queue = [];
    this.running = false;
  }
  snapshot() {
    return {
      session: this.current
        ? {
            ...this.current,
            controller: undefined,
            config: undefined,
            context: undefined,
            timer: undefined,
          }
        : null,
      captions: this.captions.slice(-80),
    };
  }
  start(config, source) {
    this.stop();
    this.captions = [];
    this.queue = [];
    this.current = {
      id: randomUUID(),
      source,
      active: true,
      startedAt: this.now(),
      lastHeartbeat: this.now(),
      received: 0,
      completed: 0,
      dropped: 0,
      failures: 0,
      latencyMs: null,
      level: 0,
      config: structuredClone(config),
      controller: new AbortController(),
      context: [],
    };
    this.emit("session", this.snapshot());
    return this.current;
  }
  stop(id) {
    if (!this.current?.active || (id && id !== this.current.id)) return;
    this.current.active = false;
    this.current.level = 0;
    this.current.controller.abort();
    clearTimeout(this.current.timer);
    this.queue = [];
    this.emit("session", this.snapshot());
  }
  require(id) {
    if (!this.current?.active || this.current.id !== id) {
      const error = new Error("字幕会话已结束，请重新开始");
      error.status = 409;
      throw error;
    }
    return this.current;
  }
  heartbeat(id, level) {
    const session = this.require(id);
    session.lastHeartbeat = this.now();
    session.level = Math.min(1, Math.max(0, Number(level) || 0));
    this.emit("meter", { id, level: session.level });
  }
  enqueue(id, wav, seconds) {
    const session = this.require(id);
    session.received++;
    if (this.queue.length >= 1) {
      this.queue.shift();
      session.dropped++;
      this.emit("warning", {
        message: "接口处理较慢，已跳过等待中的旧片段，跟上当前直播",
      });
    }
    this.queue.push({
      session,
      wav,
      seconds,
      queuedAt: this.now(),
      id: randomUUID(),
    });
    this.drain();
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        const { session } = item;
        if (session.controller.signal.aborted) continue;
        if (this.now() - item.queuedAt > 8000) {
          session.dropped++;
          continue;
        }
        try {
          const original = await this.providers.transcribe(
            session.config,
            item.wav,
            session.controller.signal,
          );
          if (!original || session.controller.signal.aborted) continue;
          const caption = {
            id: item.id,
            sessionId: session.id,
            original,
            translation: "",
            status: "translating",
            at: this.now(),
          };
          this.captions.push(caption);
          if (this.captions.length > 120) this.captions.shift();
          this.emit("caption", caption);
          const translation = await this.providers.translate(
            session.config,
            original,
            session.context,
            session.controller.signal,
          );
          if (session.controller.signal.aborted) continue;
          Object.assign(caption, {
            translation,
            status: "final",
            latencyMs: this.now() - item.queuedAt,
          });
          session.completed++;
          session.failures = 0;
          session.latencyMs = caption.latencyMs;
          session.context.push({ original, translation });
          session.context = session.context.slice(-2);
          this.emit("caption", caption);
          this.emit("stats", this.snapshot().session);
        } catch (error) {
          if (session.controller.signal.aborted) continue;
          const caption = this.captions.find((entry) => entry.id === item.id);
          if (caption) {
            caption.status = "error";
            this.emit("caption", caption);
          }
          session.failures++;
          this.emit("warning", { message: error.message });
          if (session.failures >= 3) {
            this.stop(session.id);
            this.emit("warning", {
              message: "接口连续失败 3 次，已停止采集。请检查配置后重新开始。",
            });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
  demo(config) {
    const session = this.start(config, {
      kind: "demo",
      title: "体验示例 · 未采集直播音频",
      platform: "demo",
    });
    let index = 0;
    const next = () => {
      if (!session.active || this.current !== session) return;
      const [original, translation] = demoLines[index % demoLines.length];
      const caption = {
        id: randomUUID(),
        sessionId: session.id,
        original,
        translation,
        status: "final",
        at: this.now(),
        demo: true,
      };
      this.captions.push(caption);
      if (this.captions.length > 80) this.captions.shift();
      session.completed++;
      session.level = 0.25;
      this.emit("caption", caption);
      this.emit("stats", this.snapshot().session);
      index++;
      session.timer = setTimeout(next, 4500);
    };
    next();
    return session;
  }
  checkHeartbeat() {
    if (
      this.current?.active &&
      this.current.source.kind !== "demo" &&
      this.now() - this.current.lastHeartbeat > 12000
    ) {
      this.stop();
      this.emit("warning", {
        message: "浏览器音频连接已中断，已停止会话。请在直播标签页重新开始。",
      });
    }
  }
}
