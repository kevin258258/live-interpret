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
      if (!pairing) throw new Error("请先粘贴工作台连接地址");
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
