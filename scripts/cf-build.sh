#!/usr/bin/env bash
set -e
SHA="${CF_PAGES_COMMIT_SHA:-${WORKERS_CI_COMMIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}}"
SHA="${SHA:0:7}"
rm -rf dist && mkdir -p dist
cp index.html sw.js manifest.webmanifest dist/ 2>/dev/null || true
cp -r assets dist/ 2>/dev/null || true
sed -i "s/__BUILD_ID__/${SHA}/g" dist/sw.js 2>/dev/null || true
echo "cf-build: dist ready, sw build id = ${SHA}"
ls dist
