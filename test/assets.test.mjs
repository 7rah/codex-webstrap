import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildPatchedIndexHtml } from "../src/assets.mjs";

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
