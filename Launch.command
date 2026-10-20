#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print 'Node.js 24 or newer is required: https://nodejs.org'
  read '?Press Enter to close.'
  exit 1
fi
if [[ -d "Orbit.app" ]]; then
  open "Orbit.app"
else
  node scripts/start.mjs
fi
