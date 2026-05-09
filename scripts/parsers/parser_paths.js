'use strict';
/**
 * parser_paths.js — JS port of spire-codex/backend/app/parsers/parser_paths.py.
 *
 * The dashboard's extraction pipeline writes:
 *   <ToolsDir>/extraction/raw/             ← GDRE Tools PCK extraction (resources, localization)
 *   <ToolsDir>/extraction/decompiled/      ← ILSpy CLI .cs files
 *   <AssetsDir>/data-extracted/            ← parser JSON output
 *
 * <ToolsDir> = `%APPDATA%\sts2-dashboard\Tools` (Windows) by default.
 * Caller passes the resolved paths in via the `Paths` object — this module
 * just declares the shape and provides convenience helpers.
 */

const fs   = require('fs');
const path = require('path');

function makePaths({ toolsDir, assetsDir }) {
  if (!toolsDir)  throw new Error('parser_paths: toolsDir is required');
  if (!assetsDir) throw new Error('parser_paths: assetsDir is required');
  const extractionDir = path.join(toolsDir, 'extraction');
  return {
    toolsDir,
    extractionDir,
    decompiled:  path.join(extractionDir, 'decompiled'),
    rawDir:      path.join(extractionDir, 'raw'),
    dataDir:     path.join(assetsDir, 'data-extracted'),
    locDir:      (lang) => path.join(extractionDir, 'raw', 'localization', lang),
    perLangDir:  (lang) => {
      const d = path.join(assetsDir, 'data-extracted', lang);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

module.exports = { makePaths };
