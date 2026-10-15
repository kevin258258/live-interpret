(() => {
  if (
    window.top !== window ||
    !["127.0.0.1", "localhost"].includes(location.hostname)
  )
    return;
  window.addEventListener("message", async (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== "live-interpret-panel"
    )
      return;
    const { type, requestId, token } = event.data;
    if (
      !["probe", "pair", "extensions"].includes(type) ||
      typeof requestId !== "string" ||
      requestId.length > 100
    )
      return;
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        target: "background",
        type: `panel-${type}`,
        base: location.origin,
        token,
      });
    } catch {
      result = { error: "扩展已更新，请刷新面板后再试" };
    }
    window.postMessage(
      { source: "live-interpret-extension", requestId, result },
      location.origin,
    );
  });
})();
