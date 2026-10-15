import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join, extname } from "node:path";
import { ConfigStore, publicConfig, profiles } from "./config.js";
import { LiveSession } from "./session.js";
import { translate, validateWav } from "./providers.js";
import { createDesktopIntegration } from "./desktop.js";
import {
  applicationId,
  version,
  persistentToken,
  dataDirectory,
} from "./runtime.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};
const staticFiles = new Map([
  ["/", "web/index.html"],
  ["/app.js", "web/app.js"],
  ["/panel.js", "web/panel.js"],
  ["/style.css", "web/style.css"],
  ["/events.js", "extension/lib/events.js"],
  ["/mark.svg", "web/mark.svg"],
]);

async function readBody(request, limit = 360000) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) {
      const error = new Error("请求内容过大");
      error.status = 413;
      throw error;
    }
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function jsonBody(request) {
  try {
    return JSON.parse((await readBody(request, 32000)).toString());
  } catch (error) {
    if (error.status) throw error;
    const invalid = new Error("JSON 格式不正确");
    invalid.status = 400;
    throw invalid;
  }
}
function send(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function validSource(source) {
  const url = new URL(source?.url);
  if (
    url.protocol !== "https:" ||
    !["www.youtube.com", "youtube.com", "www.twitch.tv", "twitch.tv"].includes(
      url.hostname,
    )
  )
    throw new Error("请在 YouTube 或 Twitch 标签页启动");
  return {
    kind: "live",
    platform: url.hostname.includes("youtube") ? "youtube" : "twitch",
    title: String(source.title || url.hostname).slice(0, 200),
    url: url.origin + url.pathname,
  };
}

export async function createApplication({
  directory = join(project, ".local"),
  token = randomBytes(24).toString("hex"),
  providers,
  now,
  desktop = createDesktopIntegration(),
  onShutdown,
} = {}) {
  const store = await new ConfigStore(directory).load();
  const clients = new Set();
  const emit = (type, data) => {
    const event = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const client of clients) {
      if (
        !client.destroyed &&
        !client.writableEnded &&
        client.writableLength < 256000
      )
        client.write(event);
      else {
        clients.delete(client);
        client.destroy();
      }
    }
  };
  const sessions = new LiveSession(emit, providers, now);
  let saveChain = Promise.resolve();
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    const originAllowed =
      !origin ||
      /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
      origin === `http://${host}`;
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || !originAllowed)
      return send(response, 403, {
        error: "只接受本机工作台及已配对的浏览器扩展",
      });
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      return response.end();
    }
    try {
      const url = new URL(request.url, `http://${host}`);
      if (request.method === "GET" && staticFiles.has(url.pathname)) {
        response.writeHead(200, {
          "Content-Type": mime[extname(staticFiles.get(url.pathname))],
          "Cache-Control": "no-cache",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        return response.end(
          await readFile(join(project, staticFiles.get(url.pathname))),
        );
      }
      const bearer = Buffer.from(
        request.headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      const expected = Buffer.from(token);
      if (
        bearer.length !== expected.length ||
        !timingSafeEqual(bearer, expected)
      )
        return send(response, 401, {
          error: "请使用启动时显示的工作台链接，或重新配对扩展",
        });
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /api/info")
        return send(response, 200, {
          application: applicationId,
          pid: process.pid,
          extensionPath: join(project, "extension"),
          version,
          desktop: await desktop.status(),
          canShutdown: Boolean(onShutdown),
        });
      if (route === "POST /api/desktop/install")
        return send(response, 200, await desktop.install());
      if (route === "POST /api/shutdown") {
        if (!onShutdown)
          return send(response, 409, { error: "当前运行方式不支持退出服务" });
        send(response, 200, { ok: true });
        setTimeout(() => Promise.resolve(onShutdown()).catch(() => {}), 100);
        return;
      }
      if (route === "GET /api/config")
        return send(response, 200, publicConfig(store.value));
      if (route === "PUT /api/config") {
        const body = await jsonBody(request);
        const previous = store.value;
        saveChain = saveChain.catch(() => {}).then(() => store.save(body));
        const config = await saveChain;
        if (
          JSON.stringify([
            previous.asr,
            previous.translation,
            previous.language,
            previous.profile,
          ]) !==
          JSON.stringify([
            store.value.asr,
            store.value.translation,
            store.value.language,
            store.value.profile,
          ])
        )
          sessions.stop();
        if (sessions.current)
          sessions.current.config.glossary = store.value.glossary;
        emit("config", config);
        return send(response, 200, config);
      }
      if (route === "GET /api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ type: "snapshot", data: { ...sessions.snapshot(), config: publicConfig(store.value) } })}\n\n`,
        );
        clients.add(response);
        const heartbeat = setInterval(
          () => response.write(": keep-alive\n\n"),
          15000,
        );
        response.on("close", () => {
          clients.delete(response);
          clearInterval(heartbeat);
        });
        return;
      }
      if (route === "POST /api/session") {
        if (!publicConfig(store.value).ready)
          return send(response, 400, {
            error: "请先在工作台填写识别与翻译的 API 地址和模型名",
          });
        const source = validSource((await jsonBody(request)).source);
        const session = sessions.start(store.value, source);
        return send(response, 200, {
          id: session.id,
          profile: profiles[store.value.profile],
          appearance: store.value.appearance,
        });
      }
      if (route === "POST /api/audio") {
        const id = url.searchParams.get("session");
        sessions.require(id);
        const wav = await readBody(request);
        const seconds = validateWav(wav);
        sessions.enqueue(id, wav, seconds);
        return send(response, 202, { accepted: true });
      }
      if (route === "POST /api/heartbeat") {
        const { id, level } = await jsonBody(request);
        sessions.heartbeat(id, level);
        return send(response, 200, { ok: true });
      }
      if (route === "POST /api/stop") {
        const { id } = await jsonBody(request);
        sessions.stop(id);
        return send(response, 200, { ok: true });
      }
      if (route === "POST /api/demo") {
        sessions.demo(store.value);
        return send(response, 200, { ok: true });
      }
      if (route === "POST /api/test-translation") {
        if (!store.value.translation.baseUrl || !store.value.translation.model)
          throw new Error("请先保存翻译接口配置");
        const started = Date.now();
        const text = await translate(
          store.value,
          "Thanks for coming to the stream!",
          [],
          AbortSignal.timeout(26000),
        );
        return send(response, 200, { text, elapsedMs: Date.now() - started });
      }
      return send(response, 404, { error: "没有这个接口" });
    } catch (error) {
      if (!response.headersSent)
        send(response, error.status ?? 400, {
          error:
            error.message === "Invalid URL" ? "地址格式不正确" : error.message,
        });
      else response.destroy();
    }
  });
  const watchdog = setInterval(() => sessions.checkHeartbeat(), 2000);
  watchdog.unref();
  server.on("close", () => {
    clearInterval(watchdog);
    sessions.stop();
    for (const client of clients) client.end();
  });
  return {
    server,
    store,
    sessions,
    token,
    close: async () => {
      sessions.stop();
      for (const client of clients) client.end();
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.PORT ?? 43821);
  const directory = dataDirectory();
  try {
    const app = await createApplication({
      directory,
      token: await persistentToken(directory),
      onShutdown: async () => {
        await app.close();
        process.exit(0);
      },
    });
    app.server.on("error", (error) => {
      console.error(
        error.code === "EADDRINUSE"
          ? `端口 ${port} 已被占用，请关闭旧实例或使用 PORT 指定端口。`
          : "本机服务无法启动",
      );
      process.exitCode = 1;
    });
    app.server.listen(port, "127.0.0.1", async () => {
      const url = `http://127.0.0.1:${port}/#${app.token}`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, "connection.json"),
        JSON.stringify({
          url,
          pid: process.pid,
          application: applicationId,
          version,
        }),
        { mode: 0o600 },
      );
      console.log(
        `\n  Live Interpret · 本机字幕工作台\n\n  ${url}\n\n  打开上方链接。配对地址保存在 .local/connection.json。\n  只有主动在浏览器扩展中开始后，才会采集并发送音频。\n`,
      );
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, async () => {
        await app.close();
        process.exit(0);
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
