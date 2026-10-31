import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtboardRenderer, documentCss } from "./render";
import type { Artboard } from "../../doc-core/src/index";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let fonts: string;
function embeddedFonts() {
  if (fonts) return fonts;
  fonts = [
    "@fontsource-variable/noto-sans-sc/index.css",
    "@fontsource-variable/source-serif-4/index.css",
  ]
    .map((file) => {
      const cssPath = require.resolve(file);
      return readFileSync(cssPath, "utf8").replace(
        /url\(([^)]+)\)/g,
        (_, file) =>
          `url(data:font/woff2;base64,${readFileSync(resolve(dirname(cssPath), file.replace(/["']/g, ""))).toString("base64")})`,
      );
    })
    .join("\n");
  return fonts;
}

export function renderDocumentHtml(
  design: Artboard,
  options: {
    transparent?: boolean;
    resolveAsset?: (src: string) => string;
    fontCss?: string;
  } = {},
) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${documentCss}${options.fontCss || embeddedFonts()}</style></head><body>${renderToStaticMarkup(<ArtboardRenderer design={design} {...options} />)}</body></html>`;
}
