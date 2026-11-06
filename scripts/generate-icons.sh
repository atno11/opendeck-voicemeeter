#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ICON_DIR="$ROOT_DIR/icons"

mkdir -p "$ICON_DIR"

create_icon() {
    name="$1"
    paths="$2"

    cat > "$ICON_DIR/$name.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg"
     width="144" height="144"
     viewBox="0 0 144 144"
     fill="none"
     stroke="#FFFFFF"
     stroke-width="8"
     stroke-linecap="round"
     stroke-linejoin="round">
  $paths
</svg>
EOF

    printf '[icons] Created %s.svg\n' "$name"
}

create_icon "gainup" '
  <path d="M30 72H114"/>
  <path d="M72 30V114"/>
'

create_icon "gaindown" '
  <path d="M30 72H114"/>
'

create_icon "mute" '
  <path d="M24 54H46L76 30V114L46 90H24Z"/>
  <path d="M96 55L122 89"/>
  <path d="M122 55L96 89"/>
'

create_icon "solo" '
  <path d="M103 43
           C90 27 52 26 39 47
           C20 78 112 63 105 95
           C100 120 55 119 36 100"/>
'

create_icon "mono" '
  <circle cx="58" cy="72" r="37"/>
  <circle cx="86" cy="72" r="37"/>
'

create_icon "route" '
  <path d="M22 72H62"/>
  <path d="M62 72L98 38"/>
  <path d="M62 72L98 106"/>
  <path d="M98 38H119"/>
  <path d="M98 106H119"/>
  <circle cx="119" cy="38" r="5"/>
  <circle cx="119" cy="106" r="5"/>
'

printf '[icons] All action icons generated\n'
