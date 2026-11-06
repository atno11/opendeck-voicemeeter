#!/bin/sh
set -eu

PLUGIN_ID="com.opendeck.voicemeeter.sdPlugin"

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/release"
OUTPUT_DIR="$RELEASE_DIR/$PLUGIN_ID"

STAGING_DIR=""

cleanup() {
    if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
        rm -rf -- "$STAGING_DIR"
    fi
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

log() {
    printf '\n[package] %s\n' "$1"
}

fail() {
    printf '[package] ERROR: %s\n' "$1" >&2
    exit 1
}

command -v npm >/dev/null 2>&1 ||
    fail "npm is not installed"

cd "$ROOT_DIR"

for file in \
    package.json \
    package-lock.json \
    manifest.json \
    bridge.py \
    ui/inspector.html \
    icons/plugin.svg \
    scripts/generate-icons.sh
do
    [ -f "$file" ] || fail "Missing file: $file"
done

if [ -e "$OUTPUT_DIR" ]; then
    fail "Output already exists: $OUTPUT_DIR"
fi

log "Generating action icons..."
sh scripts/generate-icons.sh

log "Checking TypeScript..."
npm run check

log "Building TypeScript..."
npm run build

[ -f dist/index.js ] ||
    fail "Missing dist/index.js"

log "Creating staging directory..."
mkdir -p "$RELEASE_DIR"

STAGING_DIR="$(
    mktemp -d "$RELEASE_DIR/.voicemeeter-staging.XXXXXX"
)"

mkdir -p \
    "$STAGING_DIR/dist" \
    "$STAGING_DIR/icons" \
    "$STAGING_DIR/ui"

log "Copying plugin assets..."

cp manifest.json bridge.py "$STAGING_DIR/"
cp dist/index.js "$STAGING_DIR/dist/"
cp ui/inspector.html "$STAGING_DIR/ui/"

for name in \
    plugin \
    gainup \
    gaindown \
    mute \
    solo \
    mono \
    route
do
    cp "icons/$name.svg" "$STAGING_DIR/icons/"
done

cp package.json package-lock.json "$STAGING_DIR/"

log "Installing production dependencies..."

(
    cd "$STAGING_DIR"
    npm ci \
        --omit=dev \
        --ignore-scripts \
        --no-audit \
        --no-fund
)

log "Validating plugin package..."

for file in \
    manifest.json \
    bridge.py \
    dist/index.js \
    ui/inspector.html \
    icons/plugin.svg \
    icons/gainup.svg \
    icons/gaindown.svg \
    icons/mute.svg \
    icons/solo.svg \
    icons/mono.svg \
    icons/route.svg \
    node_modules/ws/package.json
do
    [ -f "$STAGING_DIR/$file" ] ||
        fail "Missing packaged file: $file"
done

log "Publishing package..."

mv -- "$STAGING_DIR" "$OUTPUT_DIR"
STAGING_DIR=""

log "Package ready:"
printf '%s\n' "$OUTPUT_DIR"
