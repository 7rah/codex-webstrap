import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPatchedIndexHtml,
  readLocalFileReference,
  resolveLocalFileReference
} from "../src/assets.mjs";

test("buildPatchedIndexHtml injects a CSP-safe runtime config script for the shim", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-webstrap-assets-test-"));
  const indexPath = path.join(tempDir, "index.html");

  await fs.writeFile(
    indexPath,
    [
      "<!doctype html>",
      "<html>",
      "<head>",
      '  <meta charset="utf-8">',
      "</head>",
      "<body>",
      '  <div id="root"></div>',
      "</body>",
      "</html>"
    ].join("\n")
  );

  const html = await buildPatchedIndexHtml(indexPath, {
    runtimeConfig: {
      sentryInitOptions: {
        appVersion: "26.311.21342",
        buildNumber: "993",
        buildFlavor: "prod",
        codexAppSessionId: null,
        dsn: null
      }
    }
  });

  assert.doesNotMatch(html, /window\.__CODEX_WEBSTRAP_CONFIG/);
  assert.match(html, /<script src="\/__webstrapper\/runtime-config\.js"><\/script>/);
  assert.match(html, /<script src="\/__webstrapper\/shim\.js"><\/script>/);
});

test("buildPatchedIndexHtml is idempotent when runtime config script is already present", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-webstrap-assets-test-"));
  const indexPath = path.join(tempDir, "index.html");

  await fs.writeFile(
    indexPath,
    [
      "<!doctype html>",
      "<html>",
      "<head>",
      '  <meta charset="utf-8">',
      '  <script src="/__webstrapper/runtime-config.js"></script>',
      '  <script src="/__webstrapper/shim.js"></script>',
      "</head>",
      "<body>",
      '  <div id="root"></div>',
      "</body>",
      "</html>"
    ].join("\n")
  );

  const html = await buildPatchedIndexHtml(indexPath, {
    runtimeConfig: {
      sentryInitOptions: {
        appVersion: "26.311.21342",
        buildNumber: "993",
        buildFlavor: "prod",
        codexAppSessionId: null,
        dsn: null
      }
    }
  });

  assert.equal(
    html.match(/<script src="\/__webstrapper\/runtime-config\.js"><\/script>/g)?.length ?? 0,
    1
  );
  assert.equal(
    html.match(/<script src="\/__webstrapper\/shim\.js"><\/script>/g)?.length ?? 0,
    1
  );
});

test("buildPatchedIndexHtml adds runtime config without duplicating an existing shim script", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-webstrap-assets-test-"));
  const indexPath = path.join(tempDir, "index.html");

  await fs.writeFile(
    indexPath,
    [
      "<!doctype html>",
      "<html>",
      "<head>",
      '  <meta charset="utf-8">',
      '  <script src="/__webstrapper/shim.js"></script>',
      "</head>",
      "<body>",
      '  <div id="root"></div>',
      "</body>",
      "</html>"
    ].join("\n")
  );

  const html = await buildPatchedIndexHtml(indexPath, {
    runtimeConfig: {
      sentryInitOptions: {
        appVersion: "26.311.21342",
        buildNumber: "993",
        buildFlavor: "prod",
        codexAppSessionId: null,
        dsn: null
      }
    }
  });

  assert.equal(
    html.match(/<script src="\/__webstrapper\/runtime-config\.js"><\/script>/g)?.length ?? 0,
    1
  );
  assert.equal(
    html.match(/<script src="\/__webstrapper\/shim\.js"><\/script>/g)?.length ?? 0,
    1
  );
});

test("resolveLocalFileReference accepts absolute image paths and file URLs", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-webstrap-local-file-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const imagePath = path.join(tempDir, "photo one.png");
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  assert.equal(resolveLocalFileReference(imagePath), imagePath);
  assert.equal(resolveLocalFileReference(pathToFileURL(imagePath).href), imagePath);
  assert.equal(resolveLocalFileReference(`https://example.com/${path.basename(imagePath)}`), null);
  assert.equal(resolveLocalFileReference("/assets/logo.png"), null);
});

test("readLocalFileReference reads local image content and rejects unsupported files", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-webstrap-local-file-read-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const imagePath = path.join(tempDir, "snapshot.jpg");
  const textPath = path.join(tempDir, "notes.txt");

  await fs.writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
  await fs.writeFile(textPath, "not an image");

  const imageResult = await readLocalFileReference(pathToFileURL(imagePath).href);
  assert.ok(imageResult);
  assert.equal(imageResult.filePath, imagePath);
  assert.equal(imageResult.contentType, "image/jpeg");
  assert.deepEqual(imageResult.body, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));

  const textResult = await readLocalFileReference(textPath);
  assert.equal(textResult, null);
});
