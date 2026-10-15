async function offscreenExists() {
  return (
    (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))
      .length > 0
  );
}

async function forward(message) {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== "background") return;
  (async () => {
    if (
      ["panel-probe", "panel-pair", "panel-extensions"].includes(message.type)
    ) {
      const senderUrl = new URL(sender.url || "https://invalid.example");
      if (
        senderUrl.protocol !== "http:" ||
        !["127.0.0.1", "localhost"].includes(senderUrl.hostname) ||
        senderUrl.origin !== message.base ||
        !/^[a-f0-9]{48}$/.test(message.token || "")
      ) {
        throw new Error("仅接受本机面板的连接请求");
      }
      const { pairing } = await chrome.storage.local.get("pairing");
      if (message.type === "panel-extensions") {
        await chrome.tabs.create({ url: "chrome://extensions" });
        return {
          installed: true,
          paired:
            pairing?.base === message.base && pairing?.token === message.token,
        };
      }
      if (message.type === "panel-pair") {
        const response = await fetch(`${message.base}/api/config`, {
          headers: { Authorization: `Bearer ${message.token}` },
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok)
          throw new Error("无法验证本机面板，请重新从应用菜单打开");
        if (
          (pairing?.base !== message.base ||
            pairing?.token !== message.token) &&
          (await offscreenExists())
        )
          await forward({ type: "stop" });
        await chrome.storage.local.set({
          pairing: { base: message.base, token: message.token },
        });
        return { installed: true, paired: true };
      }
      return {
        installed: true,
        paired:
          pairing?.base === message.base && pairing?.token === message.token,
      };
    }
    if (message.type === "status")
      return (await offscreenExists())
        ? forward({ type: "status" })
        : { active: false };
    if (message.type === "start") {
      const tab = await chrome.tabs.get(message.tabId);
      const url = new URL(tab.url);
      if (
        ![
          "www.youtube.com",
          "youtube.com",
          "www.twitch.tv",
          "twitch.tv",
        ].includes(url.hostname)
      )
        throw new Error("请先打开 YouTube 或 Twitch 直播标签页");
      const { pairing } = await chrome.storage.local.get("pairing");
      if (!pairing)
        throw new Error("请先打开 Live Interpret 面板，点击「一键连接扩展」");
      if (!(await offscreenExists())) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA"],
          justification:
            "Capture the selected livestream tab and preserve original audio playback.",
        });
      }
      await forward({ type: "stop" });
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });
      return forward({
        type: "start",
        streamId,
        pairing,
        tabId: tab.id,
        source: { url: tab.url, title: tab.title },
      });
    }
    if (message.type === "stop")
      return (await offscreenExists())
        ? forward({ type: "stop" })
        : { ok: true };
    if (message.type === "to-tab") {
      if (sender.url !== chrome.runtime.getURL("offscreen.html")) return;
      await chrome.tabs
        .sendMessage(message.tabId, {
          type: "live-interpret",
          event: message.event,
        })
        .catch(() => {});
      return { ok: true };
    }
    if (message.type === "overlay-ready" && (await offscreenExists())) {
      return forward({ type: "replay", tabId: sender.tab?.id });
    }
    if (message.type === "toggle") {
      await chrome.tabs.sendMessage(message.tabId, {
        type: "live-interpret-toggle",
      });
      return { ok: true };
    }
  })()
    .then((value) => respond(value ?? { ok: true }))
    .catch((error) => respond({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (await offscreenExists()) await forward({ type: "tab-closed", tabId });
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url && (await offscreenExists()))
    await forward({ type: "navigate", tabId, url: changeInfo.url });
});
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-subtitles") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab)
    chrome.tabs
      .sendMessage(tab.id, { type: "live-interpret-toggle" })
      .catch(() => {});
});
