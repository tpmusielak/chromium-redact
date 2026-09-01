#!/usr/bin/env bash
# Build the Chrome Web Store upload zip into dist/.
#
# Builds through a staging directory rather than zipping the working tree with
# exclusion patterns: the store rejects a package whose manifest.json is not at
# the root, and an over-broad -x pattern silently shipping test fixtures or a
# stray editor swapfile is the kind of thing you only notice post-review.
# Staging makes the payload an explicit allowlist.
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
out="dist/keyword-redact-${version}.zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# Refuse to build a package whose manifest points at files that are not there;
# a missing icon is a listing rejection, and Chrome fails the load silently.
python3 - <<'PY'
import json, sys, os
m = json.load(open("manifest.json"))
refs = set()
for size, p in (m.get("icons") or {}).items():
    refs.add(p)
for size, p in ((m.get("action") or {}).get("default_icon") or {}).items():
    refs.add(p)
for key in (("background", "service_worker"), ("action", "default_popup")):
    v = m.get(key[0], {}).get(key[1])
    if v:
        refs.add(v)
v = (m.get("options_ui") or {}).get("page")
if v:
    refs.add(v)
missing = sorted(p for p in refs if not os.path.isfile(p))
if missing:
    sys.exit("manifest references missing files: " + ", ".join(missing))
PY

# The payload, explicitly. Anything not listed here does not ship.
mkdir -p "$stage/src"
cp manifest.json "$stage/"
cp src/*.js src/*.html src/*.css "$stage/src/"
mkdir -p "$stage/src/icons"
cp src/icons/*.png "$stage/src/icons/"

# Editor and Finder droppings can appear inside the staged copy too.
find "$stage" \( -name '.DS_Store' -o -name '*~' -o -name '*.swp' \) -delete

mkdir -p dist
rm -f "$out"
# -X drops extra file attributes; macOS resource forks otherwise inflate the
# package and show up as junk entries in the store's extracted view.
(cd "$stage" && zip -q -r -X "$OLDPWD/$out" .)

echo "$out"
unzip -l "$out"
