export function initializePanel({
  token,
  api,
  getConfig,
  openSettings,
  openConnect,
  toast,
  onShutdown,
}) {
  const $ = (id) => document.getElementById(id);
  const pending = new Map();
  let extension = { installed: false, paired: false };
  let probing = false;
  let connecting = false;

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== "live-interpret-extension"
    )
      return;
    const request = pending.get(event.data.requestId);
    if (!request) return;
    pending.delete(event.data.requestId);
    clearTimeout(request.timer);
    if (event.data.result?.error)
      request.reject(new Error(event.data.result.error));
    else request.resolve(event.data.result);
  });
  function extensionRequest(type) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("还没有检测到扩展，请先安装或刷新面板"));
      }, 1800);
      pending.set(requestId, { resolve, reject, timer });
      window.postMessage(
        { source: "live-interpret-panel", type, requestId, token },
        location.origin,
      );
    });
  }
  function render() {
    const ready = getConfig()?.ready;
    $("watch").replaceChildren(
      document.createTextNode(ready ? "开始观看" : "设置翻译服务"),
      arrow(),
    );
    $("connect-label").textContent = extension.paired
      ? "浏览器已连接"
      : extension.installed
        ? "一键连接扩展"
        : "连接浏览器扩展";
    $("extension-step-label").textContent = extension.paired
      ? "浏览器已连接"
      : "连接浏览器";
    $("step-extension").classList.toggle("complete", extension.paired);
    $("browser-status").textContent = extension.paired
      ? "已就绪 · 在直播页点击扩展开始"
      : extension.installed
        ? "已检测到扩展，点击即可连接"
        : "仅采集你主动选择的标签页";
    $("extension-dialog-status").textContent = extension.paired
      ? "浏览器已连接。打开直播，在扩展里开始同传就好。"
      : extension.installed
        ? "已经找到扩展。点击下方「一键连接扩展」即可完成。"
        : "首次安装后，一键连接；以后直接在直播页开始同传。";
    $("pair-extension").disabled =
      !extension.installed || extension.paired || connecting;
    $("pair-extension").textContent = connecting
      ? "正在连接…"
      : extension.paired
        ? "已连接 ✓"
        : "一键连接扩展 ↗";
    $("extension-manager").textContent = extension.installed
      ? "打开扩展管理 ↗"
      : "复制扩展管理地址 ↗";
  }
  function arrow() {
    const span = document.createElement("span");
    span.textContent = "↗";
    return span;
  }
  async function probe() {
    if (probing || !token) return;
    probing = true;
    try {
      extension = await extensionRequest("probe");
    } catch {
      extension = { installed: false, paired: false };
    } finally {
      probing = false;
      render();
    }
  }
  async function connect() {
    if (!extension.installed) {
      await openConnect();
      return false;
    }
    if (extension.paired) return true;
    connecting = true;
    render();
    try {
      extension = await extensionRequest("pair");
      toast("浏览器已连接。以后打开应用，就能直接进入直播。 ");
      return true;
    } catch (error) {
      toast(error.message, true);
      return false;
    } finally {
      connecting = false;
      render();
    }
  }
  async function showDesktopStatus() {
    try {
      const info = await api("/api/info");
      $("quit-app").hidden = !info.canShutdown;
      if (!info.desktop.supported) {
        $("install-desktop").disabled = true;
        $("desktop-status").textContent = "应用菜单入口暂只支持 Linux";
        return;
      }
      if (info.desktop.installed) desktopInstalled();
    } catch {
      /* Connection UI already handles an unavailable local service. */
    }
  }
  function desktopInstalled() {
    $("install-desktop").textContent = "已添加 ✓";
    $("install-desktop").disabled = true;
    $("desktop-status").textContent =
      "下次在应用菜单搜索 Live Interpret，即可打开。";
  }
  $("install-desktop").onclick = async () => {
    $("install-desktop").disabled = true;
    $("install-desktop").textContent = "正在添加…";
    try {
      await api("/api/desktop/install", "POST", {});
      desktopInstalled();
      toast("已添加到应用菜单，下次点 Live Interpret 图标即可启动。");
    } catch (error) {
      $("install-desktop").disabled = false;
      $("install-desktop").textContent = "添加到应用菜单 ＋";
      toast(error.message, true);
    }
  };
  $("watch").onclick = async () => {
    if (!getConfig()?.ready) {
      openSettings();
      return;
    }
    if (await connect()) $("watch-dialog").showModal();
  };
  $("connect").onclick = async () => {
    if (extension.paired) await openConnect();
    else await connect();
  };
  $("step-extension").onclick = $("connect").onclick;
  $("pair-extension").onclick = connect;
  $("refresh-extension").onclick = () => location.reload();
  $("extension-manager").onclick = async () => {
    try {
      if (extension.installed) await extensionRequest("extensions");
      else {
        await navigator.clipboard.writeText("chrome://extensions");
        toast("已复制。在浏览器地址栏粘贴即可打开扩展管理。");
      }
    } catch {
      toast("请在浏览器地址栏输入 chrome://extensions", true);
    }
  };
  $("quit-app").onclick = () => $("quit-dialog").showModal();
  $("confirm-quit").onclick = async () => {
    $("confirm-quit").disabled = true;
    try {
      await api("/api/shutdown", "POST", {});
      onShutdown();
      $("quit-dialog").close();
      $("shutdown-screen").hidden = false;
    } catch (error) {
      toast(error.message, true);
      $("confirm-quit").disabled = false;
    }
  };
  window.addEventListener("focus", probe);
  setTimeout(probe, 150);
  setTimeout(() => {
    if (!extension.installed) probe();
  }, 2300);
  showDesktopStatus();
  render();
  return { render };
}
