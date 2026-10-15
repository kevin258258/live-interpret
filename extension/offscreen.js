import { SpeechSegmenter, resample } from "./lib/audio.js";
import { readEvents } from "./lib/events.js";

let capture = null;
let transition = Promise.resolve();

async function api(current, path, body, raw = false) {
  const response = await fetch(`${current.pairing.base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${current.pairing.token}`,
      "Content-Type": raw ? "audio/wav" : "application/json",
    },
    body: raw ? body : JSON.stringify(body),
    signal: AbortSignal.any([
      current.controller.signal,
      AbortSignal.timeout(8000),
    ]),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "工作台请求失败");
  return result;
}

function send(current, event) {
  return chrome.runtime
    .sendMessage({
      target: "background",
      type: "to-tab",
      tabId: current.tabId,
      event,
    })
    .catch(() => {});
}

async function stop(notifyServer = true) {
  const old = capture;
  if (!old) return;
  capture = null;
  clearInterval(old.heartbeat);
  old.node?.disconnect();
  old.sourceNode?.disconnect();
  old.stream?.getTracks().forEach((track) => track.stop());
  await old.context?.close().catch(() => {});
  if (notifyServer && old.id)
    await api(old, "/api/stop", { id: old.id }).catch(() => {});
  old.controller.abort();
  await send(old, { type: "stopped" });
}

async function start(message) {
  await stop();
  const current = {
    ...message,
    controller: new AbortController(),
    level: 0,
    uploading: 0,
    lastCaption: null,
  };
  capture = current;
  try {
    current.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
      video: false,
    });
    current.context = new AudioContext();
    current.sourceNode = current.context.createMediaStreamSource(
      current.stream,
    );
    // Keep the unmodified, full-rate original audio audible. Only the ASR branch is downsampled.
    current.sourceNode.connect(current.context.destination);
    await current.context.resume();
    const session = await api(current, "/api/session", {
      source: message.source,
    });
    current.id = session.id;
    current.appearance = session.appearance;
    const segmenter = new SpeechSegmenter(session.profile, (wav) => {
      if (capture !== current) return;
      if (current.uploading >= 2) {
        send(current, {
          type: "warning",
          data: { message: "本机连接较慢，已跳过旧片段" },
        });
        return;
      }
      current.uploading++;
      api(
        current,
        `/api/audio?session=${encodeURIComponent(current.id)}`,
        wav,
        true,
      )
        .catch((error) => {
          if (capture === current) {
            send(current, {
              type: "warning",
              data: { message: error.message },
            });
            stop();
          }
        })
        .finally(() => current.uploading--);
    });
    await current.context.audioWorklet.addModule(
      chrome.runtime.getURL("pcm-worklet.js"),
    );
    current.node = new AudioWorkletNode(current.context, "pcm-capture");
    const silent = current.context.createGain();
    silent.gain.value = 0;
    const filter = current.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 7200;
    current.sourceNode
      .connect(filter)
      .connect(current.node)
      .connect(silent)
      .connect(current.context.destination);
    current.node.port.onmessage = (event) => {
      if (capture !== current) return;
      current.frames = (current.frames || 0) + 1;
      current.level = segmenter.push(
        resample(event.data, current.context.sampleRate),
      );
    };
    current.heartbeat = setInterval(() => {
      api(current, "/api/heartbeat", {
        id: current.id,
        level: Math.min(1, current.level * 6),
      }).catch((error) => {
        if (capture === current) {
          send(current, { type: "warning", data: { message: error.message } });
          stop();
        }
      });
    }, 1500);
    current.stream.getTracks().forEach((track) =>
      track.addEventListener("ended", () => {
        if (capture === current) stop();
      }),
    );
    await send(current, {
      type: "started",
      data: { appearance: current.appearance },
    });
    const response = await fetch(`${current.pairing.base}/api/events`, {
      headers: { Authorization: `Bearer ${current.pairing.token}` },
      signal: current.controller.signal,
    });
    readEvents(response, (event) => {
      if (capture !== current) return;
      if (event.type === "config") {
        current.appearance = event.data.appearance;
        send(current, event);
      }
      if (event.type === "caption" && event.data.sessionId === current.id) {
        current.lastCaption = event;
        send(current, event);
      }
      if (event.type === "warning") send(current, event);
      if (
        event.type === "session" &&
        (!event.data.session?.active || event.data.session.id !== current.id)
      )
        stop(false);
      if (
        event.type === "snapshot" &&
        (!event.data.session?.active || event.data.session.id !== current.id)
      )
        stop(false);
    })
      .then(() => {
        if (capture === current) stop(false);
      })
      .catch(() => {
        if (capture === current) {
          send(current, {
            type: "warning",
            data: { message: "工作台连接中断，请重新开始同传" },
          });
          stop(false);
        }
      });
    return { active: true };
  } catch (error) {
    await stop();
    throw new Error(
      error.message.includes("fetch")
        ? "无法连接本机应用，请从应用菜单打开 Live Interpret"
        : error.message,
    );
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.target !== "offscreen") return;
  if (message.type === "status") {
    respond({
      active: Boolean(capture),
      tabId: capture?.tabId,
      audioState: capture?.context?.state,
      sampleRate: capture?.context?.sampleRate,
      frames: capture?.frames || 0,
      level: capture?.level || 0,
    });
    return;
  }
  transition = transition
    .catch(() => {})
    .then(async () => {
      if (message.type === "start") return start(message);
      if (
        message.type === "stop" ||
        (message.type === "tab-closed" && message.tabId === capture?.tabId)
      ) {
        await stop();
        return { ok: true };
      }
      if (
        message.type === "navigate" &&
        capture?.tabId === message.tabId &&
        message.url !== capture.source.url
      ) {
        // Changing channels ends the old session; explicitly restart on the new stream to avoid mixed subtitles.
        await send(capture, {
          type: "warning",
          data: { message: "直播地址已改变，请在新直播上重新开始同传" },
        });
        await stop();
      }
      if (message.type === "replay" && capture?.tabId === message.tabId) {
        await send(capture, {
          type: "started",
          data: { appearance: capture.appearance },
        });
        if (capture.lastCaption) await send(capture, capture.lastCaption);
      }
      return { ok: true };
    });
  transition.then(respond).catch((error) => respond({ error: error.message }));
  return true;
});
