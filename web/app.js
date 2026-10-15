import { readEvents } from "/events.js";
import { initializePanel } from "/panel.js";

const $ = (id) => document.getElementById(id);
const hash = location.hash.slice(1);
if (hash) {
  sessionStorage.setItem("live-interpret-token", hash);
  history.replaceState(null, "", location.pathname);
}
const token = sessionStorage.getItem("live-interpret-token") || "";
let config = null;
let session = null;
let captions = [];
let toastTimer;
let reconnectTimer;
let styleTimer;
let captionTimer;
let glossaryDirty = false;
let extensionPath = "项目目录 / extension";
let panel;
let shuttingDown = false;

function toast(text, error = false) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  $("toast").classList.toggle("error", error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => ($("toast").hidden = true),
    error ? 8500 : 4000,
  );
}
async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败");
  return value;
}

function updateConnection(value) {
  $("server-dot").classList.toggle("connected", value);
  $("server-status").firstChild.textContent = value
    ? "本机服务已连接"
    : "本机服务未连接";
}
function applyAppearance(appearance) {
  $("font-size").value = appearance.fontSize;
  $("bottom").value = appearance.bottom;
  $("opacity").value = appearance.opacity;
  $("show-original").checked = appearance.showOriginal;
  $("font-size-value").value = `${appearance.fontSize} px`;
  $("bottom-value").value = `${appearance.bottom} %`;
  $("opacity-value").value = `${appearance.opacity} %`;
  $("caption-stage").style.setProperty(
    "--caption-size",
    `${appearance.fontSize}px`,
  );
  $("caption-stage").style.setProperty(
    "--caption-bottom",
    `${appearance.bottom + 6}%`,
  );
  $("caption-stage").style.setProperty(
    "--caption-opacity",
    appearance.opacity / 100,
  );
  $("preview-original").hidden = !appearance.showOriginal;
}
function applyConfig(value) {
  config = value;
  $("language").value = value.language;
  $("profile").value = value.profile;
  $("stage-language").textContent =
    `${{ ja: "日语", en: "英语", auto: "自动识别" }[value.language]} → 简体中文`;
  $("asr-state").textContent = value.asr.model || "尚未设置";
  $("translation-state").textContent = value.translation.model || "尚未设置";
  $("asr-dot").classList.toggle(
    "ready",
    Boolean(value.asr.baseUrl && value.asr.model),
  );
  $("translation-dot").classList.toggle(
    "ready",
    Boolean(value.translation.baseUrl && value.translation.model),
  );
  $("step-api").classList.toggle("complete", value.ready);
  if (!glossaryDirty) $("glossary").value = value.glossary;
  $("glossary-count").textContent = value.glossary
    .split("\n")
    .filter((line) => line.trim()).length;
  applyAppearance(value.appearance);
  panel?.render();
}
function applySession(value) {
  const changed = session?.id !== value?.id;
  session = value;
  const active = value?.active;
  const demo = value?.source.kind === "demo";
  $("session-dot").className = `status-dot ${active ? "live" : ""}`;
  $("mode-badge").textContent = active
    ? demo
      ? "体验示例 · 无音频"
      : "正在同传"
    : "等待连接";
  $("mode-badge").className = `badge ${active ? (demo ? "demo" : "live") : ""}`;
  $("source-title").textContent = active
    ? value.source.title
    : "你的下一个现场，从这里开始";
  $("audio-state").textContent = active
    ? demo
      ? "示例文字 · 未采集音频"
      : `${value.source.platform === "youtube" ? "YouTube" : "Twitch"} 标签页`
    : "等待直播音频";
  $("stop").hidden = !active;
  $("demo").disabled = active && !demo;
  $("language").disabled = active && !demo;
  $("profile").disabled = active && !demo;
  $("stage-hint").textContent =
    active && demo ? "示例内容，非实时识别" : "保留主播原声";
  if (changed) {
    captions = [];
    renderHistory();
  }
  if (!active) {
    clearTimeout(captionTimer);
    $("stage-captions").hidden = true;
    $("stage-empty").hidden = false;
    $("caption-stage").classList.remove("has-captions");
    $("stage-empty").querySelector("strong").textContent =
      "把注意力，留给喜欢的人。";
    $("stage-empty").querySelector("span").textContent =
      "连接直播后，中文字幕会出现在播放器上。这里同步显示字幕，方便调节阅读效果。";
    updateMeter(0);
  } else if (changed) {
    $("stage-empty").querySelector("strong").textContent = demo
      ? "正在播放字幕示例…"
      : "正在聆听直播…";
    $("stage-empty").querySelector("span").textContent = demo
      ? "示例不采集音频，也不调用 API。"
      : "语音断句并完成处理后，字幕会自动出现。";
  }
  renderStats();
}
function renderStats() {
  $("completed").replaceChildren(
    document.createTextNode(String(session?.completed || 0)),
    small(" 段"),
  );
  $("latency").replaceChildren(
    document.createTextNode(
      session?.source.kind !== "demo" && session?.latencyMs
        ? (session.latencyMs / 1000).toFixed(1)
        : "—",
    ),
    small(" s"),
  );
  $("skipped").hidden = !session?.dropped;
  $("skipped").textContent =
    `已跳过 ${session?.dropped || 0} 个积压片段，优先跟上直播`;
}
function small(text) {
  const element = document.createElement("small");
  element.textContent = text;
  return element;
}
function updateMeter(level) {
  [...$("audio-level").children].forEach((bar, index) => {
    bar.style.height = `${4 + Math.min(1, level) * (index % 2 ? 16 : 11)}px`;
    bar.style.background = level > 0.03 ? "#dddddd" : "#626262";
  });
}
function elapsed(at) {
  const seconds = Math.max(
    0,
    Math.floor((at - (session?.startedAt || at)) / 1000),
  );
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function renderHistory() {
  $("caption-count").textContent = captions.length;
  $("export").disabled = !captions.length;
  if (!captions.length) {
    $("history").replaceChildren($("history-empty") || emptyHistory());
    return;
  }
  const fragments = document.createDocumentFragment();
  for (const caption of captions) {
    const row = document.createElement("div");
    row.className = "history-item";
    const time = document.createElement("time");
    time.textContent = elapsed(caption.at);
    const content = document.createElement("div");
    const translation = document.createElement("p");
    translation.textContent =
      caption.translation ||
      (caption.status === "error" ? "这一段翻译失败" : "正在翻译…");
    if (!caption.translation) translation.className = "pending";
    content.append(translation, small(caption.original));
    row.append(time, content);
    fragments.append(row);
  }
  const before = $("history").scrollTop;
  $("history").replaceChildren(fragments);
  $("history").scrollTop = $("follow").checked
    ? $("history").scrollHeight
    : before;
}
function emptyHistory() {
  const element = document.createElement("div");
  element.className = "history-empty";
  element.id = "history-empty";
  const quote = document.createElement("span");
  quote.textContent = "“";
  const content = document.createElement("div");
  content.textContent = "还没有字幕记录";
  content.append(small("开始同传后，在这里回看没听清的那一句。"));
  element.append(quote, content);
  return element;
}
function applyCaption(caption) {
  if (caption.sessionId !== session?.id) return;
  const index = captions.findIndex((item) => item.id === caption.id);
  if (index === -1) captions.push(caption);
  else captions[index] = caption;
  captions = captions.slice(-80);
  $("stage-empty").hidden = true;
  $("stage-captions").hidden = false;
  $("caption-stage").classList.add("has-captions");
  $("preview-original").textContent = caption.original;
  $("preview-translation").textContent = caption.translation;
  $("caption-pending").hidden = caption.status !== "translating";
  clearTimeout(captionTimer);
  captionTimer = setTimeout(
    () => {
      $("stage-captions").hidden = true;
      $("stage-empty").hidden = false;
      $("stage-empty").querySelector("strong").textContent = "正在听下一句…";
      $("stage-empty").querySelector("span").textContent =
        "字幕会在检测到声音并完成处理后出现。";
    },
    caption.status === "translating"
      ? 28000
      : Math.min(
          12000,
          Math.max(4500, (caption.translation?.length || 0) * 180),
        ),
  );
  renderHistory();
}

function eventReceived({ type, data }) {
  if (type === "snapshot") {
    applyConfig(data.config);
    applySession(data.session);
    captions = data.captions || [];
    renderHistory();
    if (session?.active && captions.length) applyCaption(captions.at(-1));
  }
  if (type === "config") applyConfig(data);
  if (type === "session") {
    applySession(data.session);
    captions = data.captions || [];
    renderHistory();
  }
  if (type === "caption") applyCaption(data);
  if (type === "meter" && data.id === session?.id) updateMeter(data.level);
  if (type === "stats" && data.id === session?.id) {
    session = data;
    renderStats();
  }
  if (type === "warning") toast(data.message, true);
}
async function connectEvents() {
  try {
    const response = await fetch("/api/events", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      updateConnection(false);
      toast("请从应用菜单打开 Live Interpret，连接信息会自动带入。", true);
      return;
    }
    if (!response.ok) throw new Error("连接失败");
    updateConnection(true);
    await readEvents(response, eventReceived);
  } catch {
    /* Status below also handles a server restart. */
  }
  updateConnection(false);
  if (!shuttingDown) reconnectTimer = setTimeout(connectEvents, 2000);
}
async function save(patch) {
  const value = await api("/api/config", "PUT", patch);
  applyConfig(value);
  return value;
}

function openSettings() {
  if (!config) {
    toast("请先连接本机工作台", true);
    return;
  }
  for (const key of ["asr", "translation"]) {
    $(`${key}-base`).value = config[key].baseUrl;
    $(`${key}-model`).value = config[key].model;
    $(`${key}-key`).value = "";
    $(`${key}-key`).placeholder = config[key].hasKey
      ? "密钥已保存，留空保持原值"
      : "可留空（无鉴权的本地服务）";
    $(`${key}-clear`).checked = false;
  }
  $("settings-error").textContent = "";
  $("test-result").textContent = "";
  $("settings-dialog").showModal();
}
for (const id of ["settings", "settings-top", "step-api"])
  $(id).onclick = openSettings;
for (const button of document.querySelectorAll("[data-close]"))
  button.onclick = () => button.closest("dialog").close();
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (event) => {
    if (
      event.target === dialog &&
      (event.clientX < dialog.getBoundingClientRect().left ||
        event.clientX > dialog.getBoundingClientRect().right ||
        event.clientY < dialog.getBoundingClientRect().top ||
        event.clientY > dialog.getBoundingClientRect().bottom)
    )
      dialog.close();
  });
$("settings-form").onsubmit = async (event) => {
  event.preventDefault();
  $("save-settings").disabled = true;
  try {
    const patch = {};
    for (const key of ["asr", "translation"])
      patch[key] = {
        baseUrl: $(`${key}-base`).value,
        model: $(`${key}-model`).value,
        apiKey: $(`${key}-clear`).checked ? null : $(`${key}-key`).value,
      };
    await save(patch);
    for (const key of ["asr", "translation"]) $(`${key}-key`).value = "";
    $("settings-dialog").close();
    toast("设置已保存。连接浏览器后，即可开始观看。");
  } catch (error) {
    $("settings-error").textContent = error.message;
  } finally {
    $("save-settings").disabled = false;
  }
};
$("test-translation").onclick = async () => {
  $("test-translation").disabled = true;
  $("test-result").textContent =
    "正在调用已保存的翻译接口（会产生服务商用量）…";
  try {
    const result = await api("/api/test-translation", "POST", {});
    $("test-result").textContent =
      `✓ ${result.text} · ${(result.elapsedMs / 1000).toFixed(1)} 秒`;
  } catch (error) {
    $("test-result").textContent = error.message;
  } finally {
    $("test-translation").disabled = false;
  }
};
async function openConnect() {
  try {
    extensionPath = (await api("/api/info")).extensionPath;
  } catch {
    /* The manual relative path remains useful offline. */
  }
  $("extension-path").textContent = extensionPath;
  $("connect-dialog").showModal();
}
$("connect").onclick = openConnect;
$("step-extension").onclick = openConnect;
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    toast("浏览器没有剪贴板权限，请手动复制显示的路径或启动链接", true);
  }
}
$("copy-path").onclick = () => copy(extensionPath);
$("copy-connection").onclick = () =>
  token
    ? copy(`${location.origin}/#${token}`)
    : toast("请使用启动时显示的完整链接打开工作台", true);
$("demo").onclick = async () => {
  try {
    await api("/api/demo", "POST", {});
    toast("正在播放文字示例，不采集音频、不调用 API。");
  } catch (error) {
    toast(error.message, true);
  }
};
$("stop").onclick = async () => {
  try {
    await api("/api/stop", "POST", {});
    toast("已停止会话");
  } catch (error) {
    toast(error.message, true);
  }
};
for (const field of ["language", "profile"])
  $(field).onchange = async () => {
    try {
      await save({ [field]: $(field).value });
    } catch (error) {
      toast(error.message, true);
    }
  };
function currentAppearance() {
  return {
    fontSize: Number($("font-size").value),
    bottom: Number($("bottom").value),
    opacity: Number($("opacity").value),
    showOriginal: $("show-original").checked,
  };
}
for (const id of ["font-size", "bottom", "opacity", "show-original"])
  $(id).addEventListener("input", () => {
    const appearance = currentAppearance();
    applyAppearance(appearance);
    clearTimeout(styleTimer);
    styleTimer = setTimeout(async () => {
      try {
        await save({ appearance });
      } catch (error) {
        toast(error.message, true);
        if (config) applyAppearance(config.appearance);
      }
    }, 300);
  });
for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => {
    const view = button.dataset.view;
    $("studio-view").hidden = view !== "studio";
    $("glossary-view").hidden = view !== "glossary";
    $("page-crumb").textContent =
      view === "studio" ? "字幕工作台" : "个人术语表";
    document
      .querySelectorAll("[data-view]")
      .forEach((item) => item.classList.toggle("active", item === button));
  };
$("glossary").addEventListener("input", () => {
  glossaryDirty = true;
});
$("save-glossary").onclick = async () => {
  try {
    await save({ glossary: $("glossary").value });
    glossaryDirty = false;
    toast("术语表已保存，对后续片段生效");
  } catch (error) {
    toast(error.message, true);
  }
};
$("export").onclick = () => {
  const header = `${session?.source.kind === "demo" ? "Live Interpret 文字示例（非实时识别）" : "Live Interpret 字幕记录"}\n${session?.source.title || ""}\n时间为本次会话中的处理时间，不是视频时间码。\n\n`;
  const text =
    header +
    captions
      .map(
        (item) =>
          `[${elapsed(item.at)}]\n${item.translation || "（翻译未完成）"}\n${item.original}`,
      )
      .join("\n\n");
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `live-interpret-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener("beforeunload", () => {
  clearTimeout(reconnectTimer);
});
panel = initializePanel({
  token,
  api,
  getConfig: () => config,
  openSettings,
  openConnect,
  toast,
  onShutdown: () => {
    shuttingDown = true;
    clearTimeout(reconnectTimer);
  },
});
connectEvents();
