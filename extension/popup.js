const $ = (id) => document.getElementById(id);
const message = (text) => ($("message").textContent = text);
async function background(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({
    target: "background",
    type,
    ...extra,
  });
  if (result?.error) throw new Error(result.error);
  return result;
}
async function refresh() {
  const { pairing } = await chrome.storage.local.get("pairing");
  $("pairing-panel").hidden = Boolean(pairing);
  $("paired").hidden = !pairing;
  $("start").disabled = !pairing;
  const status = await background("status");
  $("start").hidden = status.active;
  $("stop").hidden = !status.active;
  $("status-dot").classList.toggle("active", status.active);
}
$("pair").onclick = async () => {
  try {
    const url = new URL($("pairing").value.trim());
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !/^[a-f0-9]{48}$/.test(url.hash.slice(1))
    )
      throw new Error("请粘贴本机启动时的完整工作台链接，包含 # 后的连接码");
    const pairing = { base: url.origin, token: url.hash.slice(1) };
    const response = await fetch(`${pairing.base}/api/config`, {
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error("连接码无效，请复制这次启动时的工作台链接");
    await chrome.storage.local.set({ pairing });
    $("pairing").value = "";
    message("");
    await refresh();
  } catch (error) {
    message(
      error.message === "Failed to fetch"
        ? "工作台未运行，请先执行 npm start"
        : error.message,
    );
  }
};
$("start").onclick = async () => {
  $("start").disabled = true;
  message("正在连接直播音频…");
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await background("start", { tabId: tab.id });
    message("字幕已开启，保留主播原声。");
    await refresh();
  } catch (error) {
    message(error.message);
  } finally {
    $("start").disabled = false;
  }
};
$("stop").onclick = async () => {
  try {
    await background("stop");
    message("已停止采集与发送音频");
    await refresh();
  } catch (error) {
    message(error.message);
  }
};
$("re-pair").onclick = async () => {
  await background("stop");
  await chrome.storage.local.remove("pairing");
  await refresh();
};
$("dashboard").onclick = async () => {
  const { pairing } = await chrome.storage.local.get("pairing");
  if (pairing) chrome.tabs.create({ url: `${pairing.base}/#${pairing.token}` });
  else message("请先启动本机服务并完成配对");
};
refresh().catch((error) => message(error.message));
