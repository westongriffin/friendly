#!/bin/sh
# Bump the app version everywhere it lives: version.json (what devices load),
# the loader's fallback in index.html, and the service worker cache name.
cd "$(dirname "$0")"
cur=$(sed -E 's/[^0-9]//g' version.json); next=$((cur+1))
echo "{\"v\":$next}" > version.json
sed -i '' "s/var v=\"$cur\"/var v=\"$next\"/" index.html
sed -i '' "s/friendly-fb-v$cur/friendly-fb-v$next/" sw.js
echo "version $cur -> $next"
