#!/bin/sh
set -eu

PLUGIN_ID="dev.atno.voicemeeter.sdPlugin"

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/release"
MODE="${1:-test}"

case "$MODE" in
    test|prod) ;;
    *)
        printf '[package] ERROR: Use test or prod\n' >&2
        exit 1
        ;;
esac

fail() {
    printf '[package] ERROR: %s\n' "$1" >&2
    exit 1
}

log() {
    printf '\n[package] %s\n' "$1"
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
    ui/visual.js \
    icons/plugin.svg \
    scripts/generate-icons.sh
do
    [ -f "$file" ] || fail "Missing file: $file"
done

log "Checking TypeScript..."
npm run check

log "Building TypeScript..."
npm run build

[ -f dist/index.js ] ||
    fail "Missing dist/index.js"

# Never replace an existing package.
if [ "$MODE" = "prod" ]; then
    OUTPUT_DIR="$RELEASE_DIR/$PLUGIN_ID"
else
    mkdir -p "$RELEASE_DIR/test"
    TEST_DIR="$(mktemp -d "$RELEASE_DIR/test/test-XXXXXXXX")"
    OUTPUT_DIR="$TEST_DIR/$PLUGIN_ID"
fi

if [ -e "$OUTPUT_DIR" ]; then
    fail "Output already exists: $OUTPUT_DIR"
fi

mkdir -p "$OUTPUT_DIR/dist" "$OUTPUT_DIR/ui" "$OUTPUT_DIR/icons"

log "Copying plugin assets..."

cp manifest.json bridge.py "$OUTPUT_DIR/"
cp dist/index.js "$OUTPUT_DIR/dist/"
cp ui/inspector.html ui/visual.js "$OUTPUT_DIR/ui/"

for name in \
    plugin \
    gainup \
    gaindown \
    mute \
    solo \
    mono \
    route
do
    cp "icons/$name.svg" "$OUTPUT_DIR/icons/"
done

cp package.json package-lock.json "$OUTPUT_DIR/"

log "Installing production dependencies..."

(
    cd "$OUTPUT_DIR"
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
    ui/visual.js \
    icons/plugin.svg \
    icons/gainup.svg \
    icons/gaindown.svg \
    icons/mute.svg \
    icons/solo.svg \
    icons/mono.svg \
    icons/route.svg \
    node_modules/ws/package.json
do
    [ -f "$OUTPUT_DIR/$file" ] ||
        fail "Missing packaged file: $file"
done

log "Package ready:"
printf '%s\n' "$OUTPUT_DIR"
