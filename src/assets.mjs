import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { safePathJoin, toErrorMessage } from "./util.mjs";

const DEFAULT_CODEX_APP = "/Applications/Codex.app";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".mjs.map": "application/json; charset=utf-8",
  ".js.map": "application/json; charset=utf-8"
};

const LOCAL_FILE_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon"
]);

const RESERVED_WEB_PATH_PREFIXES = [
  "/assets/",
  "/__webstrapper/",
  "/favicon.ico",
  "/index.html"
];

export function defaultCacheRoot() {
  return path.join(os.homedir(), ".cache", "codex-webstrap", "assets");
}

export function resolveCodexAppPaths(explicitCodexAppPath) {
  const appPath = path.resolve(explicitCodexAppPath || DEFAULT_CODEX_APP);
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const asarPath = path.join(resourcesPath, "app.asar");
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const codexCliPath = path.join(resourcesPath, "codex");
  return { appPath, resourcesPath, asarPath, infoPlistPath, codexCliPath };
}

export async function ensureCodexAppExists(paths) {
  const checks = [paths.appPath, paths.resourcesPath, paths.asarPath, paths.infoPlistPath];
  for (const filePath of checks) {
    await fsp.access(filePath, fs.constants.R_OK);
  }
}

export async function readBuildMetadata(paths) {
  const plist = await fsp.readFile(paths.infoPlistPath, "utf8");
  const bundleVersion = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "unknown";
  const shortVersion = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "unknown";
  const buildKey = `${shortVersion}-${bundleVersion}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return { bundleVersion, shortVersion, buildKey };
}

async function runAsarCliExtract(asarPath, outputPath) {
  await new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", "@electron/asar", "extract", asarPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`asar extract failed with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractAsarAll(asarPath, outputPath) {
  try {
    const module = await import("@electron/asar");
    const extractAll = module.extractAll || module.default?.extractAll;
    if (typeof extractAll === "function") {
      extractAll(asarPath, outputPath);
      return;
    }
    throw new Error("@electron/asar extractAll API unavailable");
  } catch {
    await runAsarCliExtract(asarPath, outputPath);
  }
}

export async function ensureExtractedAssets({
  asarPath,
  cacheRoot = defaultCacheRoot(),
  buildKey,
  logger
}) {
  const root = path.resolve(cacheRoot);
  const outputDir = path.join(root, buildKey);
  const doneFile = path.join(outputDir, ".extract-complete.json");

  await fsp.mkdir(root, { recursive: true, mode: 0o700 });

  const alreadyExtracted = await fsp
    .access(doneFile, fs.constants.R_OK)
    .then(() => true)
    .catch(() => false);

  if (!alreadyExtracted) {
    const tempDir = `${outputDir}.tmp-${Date.now()}`;
    await fsp.rm(tempDir, { recursive: true, force: true });
    await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });

    logger.info("Extracting Codex assets", { outputDir });
    await extractAsarAll(asarPath, tempDir);

    await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rename(tempDir, outputDir);

    await fsp.writeFile(
      doneFile,
      JSON.stringify(
        {
          extractedAt: new Date().toISOString(),
          asarPath,
          buildKey
        },
        null,
        2
      )
    );
  }

  const webRoot = path.join(outputDir, "webview");
  const workerPath = path.join(outputDir, ".vite", "build", "worker.js");
  const indexPath = path.join(webRoot, "index.html");

  await fsp.access(webRoot, fs.constants.R_OK);
  await fsp.access(indexPath, fs.constants.R_OK);

  return {
    outputDir,
    webRoot,
    indexPath,
    workerPath
  };
}

function serializeRuntimeConfig(runtimeConfig) {
  return JSON.stringify(runtimeConfig).replace(/</g, "\\u003c");
}

export function buildRuntimeConfigScript(runtimeConfig) {
  return `window.__CODEX_WEBSTRAP_CONFIG = ${serializeRuntimeConfig(runtimeConfig)};\n`;
}

export async function buildPatchedIndexHtml(indexPath, { runtimeConfig = null } = {}) {
  let html = await fsp.readFile(indexPath, "utf8");
  const shimTag = '<script src="/__webstrapper/shim.js"></script>';
  const hasShimTag = html.includes(shimTag);
  const runtimeConfigTag = runtimeConfig
    ? '<script src="/__webstrapper/runtime-config.js"></script>'
    : "";
  const hasRuntimeConfigTag = Boolean(runtimeConfigTag) && html.includes(runtimeConfigTag);
  const injectedTags = runtimeConfigTag
    ? `  ${runtimeConfigTag}\n  ${shimTag}`
    : `  ${shimTag}`;

  if (hasShimTag && (!runtimeConfigTag || hasRuntimeConfigTag)) {
    return html;
  }

  if (hasShimTag && runtimeConfigTag && !hasRuntimeConfigTag) {
    return html.replace(shimTag, `${runtimeConfigTag}\n  ${shimTag}`);
  }

  // Replace or inject mobile viewport meta — the Electron app's default
  // viewport lacks maximum-scale and user-scalable=no, causing iOS zoom issues
  const viewportMeta =
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">';
  const existingViewport = html.match(/<meta\s+name=["']viewport["'][^>]*>/i);
  if (existingViewport) {
    html = html.replace(existingViewport[0], viewportMeta);
  } else if (html.includes("</head>")) {
    html = html.replace("</head>", `  ${viewportMeta}\n</head>`);
  }

  if (html.includes("</head>")) {
    return html.replace("</head>", `${injectedTags}\n</head>`);
  }

  return `${runtimeConfigTag ? `${runtimeConfigTag}\n` : ""}${shimTag}\n${html}`;
}

export async function readStaticFile(webRoot, requestPath) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = safePathJoin(webRoot, normalized);
  if (!filePath) {
    return null;
  }

  const stat = await fsp
    .stat(filePath)
    .catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }

  const ext = path.extname(filePath);
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

  try {
    const body = await fsp.readFile(filePath);
    return { body, contentType };
  } catch (error) {
    throw new Error(`Failed reading asset ${filePath}: ${toErrorMessage(error)}`);
  }
}

export function resolveLocalFileReference(reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    return null;
  }

  let filePath = null;
  if (reference.startsWith("file://")) {
    try {
      filePath = fileURLToPath(reference);
    } catch {
      return null;
    }
  } else {
    let decoded = reference;
    try {
      decoded = decodeURIComponent(reference);
    } catch {
      decoded = reference;
    }

    if (RESERVED_WEB_PATH_PREFIXES.some((prefix) => decoded === prefix || decoded.startsWith(prefix))) {
      return null;
    }

    if (!path.isAbsolute(decoded)) {
      return null;
    }

    filePath = path.normalize(decoded);
  }

  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  if (!LOCAL_FILE_CONTENT_TYPES.has(contentType)) {
    return null;
  }

  return filePath;
}

export async function readLocalFileReference(reference) {
  const filePath = resolveLocalFileReference(reference);
  if (!filePath) {
    return null;
  }

  const stat = await fsp
    .stat(filePath)
    .catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }

  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  if (!LOCAL_FILE_CONTENT_TYPES.has(contentType)) {
    return null;
  }

  const body = await fsp.readFile(filePath);
  return {
    body,
    contentType,
    filePath
  };
}
