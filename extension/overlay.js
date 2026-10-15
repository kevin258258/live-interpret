(() => {
  if (globalThis.__liveInterpretOverlay) return;
  globalThis.__liveInterpretOverlay = true;
  const host = document.createElement("div");
  host.id = "live-interpret-subtitles";
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host { all:initial; } * { box-sizing:border-box; }
    .position { position:absolute;left:9%;right:9%;bottom:var(--bottom,9%);display:flex;flex-direction:column;align-items:center;gap:7px;font-family:system-ui,-apple-system,"Noto Sans CJK SC",sans-serif;text-align:center; }
    .translation { max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;text-wrap:balance;line-height:1.46;font-size:var(--size,30px);font-weight:650;letter-spacing:.02em;color:#fff;padding:8px 17px;border-radius:9px;background:rgb(9 13 20 / var(--opacity,.78));text-shadow:0 1px 3px #000;box-shadow:0 3px 18px #0002; }
    .original { max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;font-size:calc(var(--size,30px) * .58);line-height:1.5;color:#efefef;padding:3px 10px;background:rgb(9 13 20 / .55);border-radius:5px; }
    .notice { padding:6px 12px;border-radius:6px;background:#161c24e6;color:#f2d69a;font-size:14px; }
    [hidden] { display:none!important; }
  </style><div class="position"><div class="notice" hidden></div><div class="original" hidden></div><div class="translation" hidden></div></div>`;
  const translated = root.querySelector(".translation");
  const original = root.querySelector(".original");
  const notice = root.querySelector(".notice");
  let active = false;
  let visible = true;
  let settings = {};
  let expiry;
  let noticeExpiry;
  let lastId = null;

  function place() {
    const parent = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
    const video = [...document.querySelectorAll("video")].find(
      (item) => item.getBoundingClientRect().width > 100,
    );
    if (video && !document.fullscreenElement) {
      const rect = video.getBoundingClientRect();
      host.style.left = `${Math.max(0, rect.left)}px`;
      host.style.top = `${Math.max(0, rect.top)}px`;
      host.style.width = `${rect.width}px`;
      host.style.height = `${rect.height}px`;
    } else {
      host.style.left = "0";
      host.style.top = "0";
      host.style.width = "100%";
      host.style.height = "100%";
    }
    host.style.display = active && visible ? "block" : "none";
  }
  function appearance(value) {
    settings = value || settings;
    host.style.setProperty("--size", `${Number(settings.fontSize) || 30}px`);
    host.style.setProperty("--bottom", `${Number(settings.bottom) || 9}%`);
    host.style.setProperty(
      "--opacity",
      String((Number(settings.opacity) || 0) / 100),
    );
    original.hidden = !settings.showOriginal || !original.textContent;
  }
  function clear() {
    translated.hidden = true;
    original.hidden = true;
    translated.textContent = "";
    original.textContent = "";
    lastId = null;
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "live-interpret-toggle") {
      visible = !visible;
      place();
      return;
    }
    if (message.type !== "live-interpret") return;
    const { type, data } = message.event;
    if (type === "started") {
      active = true;
      visible = true;
      clear();
      appearance(data.appearance);
      notice.hidden = false;
      notice.textContent = "正在聆听直播…";
      clearTimeout(noticeExpiry);
      noticeExpiry = setTimeout(() => (notice.hidden = true), 4000);
    }
    if (type === "stopped") {
      active = false;
      clear();
      clearTimeout(expiry);
    }
    if (type === "config") appearance(data.appearance);
    if (type === "warning") {
      notice.textContent = data.message;
      notice.hidden = false;
      clearTimeout(noticeExpiry);
      noticeExpiry = setTimeout(() => (notice.hidden = true), 7000);
    }
    if (type === "caption") {
      if (lastId !== data.id) {
        translated.hidden = true;
        translated.textContent = "";
      }
      lastId = data.id;
      original.textContent = data.original;
      original.hidden = !settings.showOriginal;
      if (data.status === "final") {
        translated.textContent = data.translation;
        translated.hidden = false;
      }
      if (data.status === "error") {
        notice.textContent = "该片段翻译失败";
        notice.hidden = false;
      }
      clearTimeout(expiry);
      expiry = setTimeout(
        clear,
        data.status === "translating"
          ? 28000
          : Math.min(
              12000,
              Math.max(4500, (data.translation?.length || 0) * 180),
            ),
      );
    }
    place();
  });
  document.addEventListener("fullscreenchange", place);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, { passive: true });
  setInterval(() => {
    if (active) place();
  }, 1000);
  chrome.runtime
    .sendMessage({ target: "background", type: "overlay-ready" })
    .catch(() => {});
})();
