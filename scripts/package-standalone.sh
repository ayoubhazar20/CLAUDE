#!/usr/bin/env bash
# Assemble a self-contained deployment folder (.next/standalone) for Hostinger:
# copies static assets, public files, fonts, Prisma schema/migrations and the worker.
set -euo pipefail
OUT=.next/standalone
cp -r .next/static "$OUT/.next/static"
[ -d public ] && cp -r public "$OUT/public" || true
mkdir -p "$OUT/assets" && cp -r assets/fonts "$OUT/assets/fonts"
mkdir -p "$OUT/prisma" && cp -r prisma/schema.prisma prisma/migrations "$OUT/prisma/"
echo "Standalone bundle ready in $OUT — start with: node $OUT/server.js"
