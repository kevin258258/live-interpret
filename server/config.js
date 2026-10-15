import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { join } from "node:path";

export const defaults = {
  asr: { baseUrl: "", model: "", apiKey: "" },
  translation: { baseUrl: "", model: "", apiKey: "" },
  language: "ja",
  profile: "balanced",
  glossary: "",
  appearance: { fontSize: 30, bottom: 9, opacity: 78, showOriginal: true },
};

export const profiles = {
  fast: { maxSeconds: 3.5, silenceMs: 420, minSpeechMs: 160 },
  balanced: { maxSeconds: 6, silenceMs: 650, minSpeechMs: 220 },
  complete: { maxSeconds: 9, silenceMs: 850, minSpeechMs: 250 },
};

function provider(input, previous = {}) {
  if (!input || typeof input !== "object")
    throw new Error("接口配置格式不正确");
  const baseUrl = String(input.baseUrl ?? previous.baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("API 地址应为 http(s) 地址，不包含密钥、查询参数或片段");
    }
  }
  const apiKey =
    input.apiKey === null ? "" : String(input.apiKey || previous.apiKey || "");
  const model = String(input.model ?? previous.model ?? "").trim();
  if (model.length > 200 || apiKey.length > 4096 || baseUrl.length > 2000)
    throw new Error("接口配置过长");
  return { baseUrl, model, apiKey };
}

function bounded(value, fallback, min, max) {
  return Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Number(value)))
    : fallback;
}

export function normalizeConfig(input, previous = defaults) {
  const appearance = input.appearance ?? previous.appearance;
  const glossary = String(input.glossary ?? previous.glossary).trim();
  if (glossary.length > 8000) throw new Error("术语表最多 8000 个字符");
  const language = input.language ?? previous.language;
  const profile = input.profile ?? previous.profile;
  if (!["ja", "en", "auto"].includes(language) || !profiles[profile])
    throw new Error("语言或断句模式不正确");
  return {
    asr: provider(input.asr ?? previous.asr, previous.asr),
    translation: provider(
      input.translation ?? previous.translation,
      previous.translation,
    ),
    language,
    profile,
    glossary,
    appearance: {
      fontSize: bounded(appearance.fontSize, 30, 18, 56),
      bottom: bounded(appearance.bottom, 9, 2, 40),
      opacity: bounded(appearance.opacity, 78, 0, 100),
      showOriginal: Boolean(appearance.showOriginal),
    },
  };
}

export function publicConfig(config) {
  const result = structuredClone(config);
  for (const key of ["asr", "translation"]) {
    result[key].hasKey = Boolean(result[key].apiKey);
    delete result[key].apiKey;
  }
  result.ready = Boolean(
    config.asr.baseUrl &&
      config.asr.model &&
      config.translation.baseUrl &&
      config.translation.model,
  );
  return result;
}

export class ConfigStore {
  constructor(directory) {
    this.directory = directory;
    this.value = structuredClone(defaults);
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.value = normalizeConfig(
        JSON.parse(await readFile(join(this.directory, "config.json"), "utf8")),
      );
      await chmod(join(this.directory, "config.json"), 0o600);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("配置文件无法读取，请检查 .local/config.json");
    }
    return this;
  }
  async save(input) {
    const next = normalizeConfig(input, this.value);
    const target = join(this.directory, "config.json");
    await writeFile(`${target}.tmp`, JSON.stringify(next, null, 2), {
      mode: 0o600,
    });
    await chmod(`${target}.tmp`, 0o600);
    await rename(`${target}.tmp`, target);
    this.value = next;
    return publicConfig(next);
  }
}
