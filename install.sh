#!/bin/sh

set -eu

package_name="nausicaa-harness"
default_version="__NAUSICAA_DEFAULT_VERSION__"
version="${NAUSICAA_VERSION:-}"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Nausicaa requires Node.js >=22.19.0 and npm.' >&2
  printf '%s\n' 'Install Node.js from https://nodejs.org/ and run this installer again.' >&2
  exit 1
fi

node_version=$(node --version)
node_major=$(printf '%s' "$node_version" | sed 's/^v//' | cut -d. -f1)
node_minor=$(printf '%s' "$node_version" | sed 's/^v//' | cut -d. -f2)
case "$node_major:$node_minor" in
  ''|*[!0-9:]*|[0-9]|[0-9]:[!0-9]*)
    printf 'Could not parse Node.js version: %s\n' "$node_version" >&2
    exit 1
    ;;
esac
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; }; then
  printf 'Nausicaa requires Node.js >=22.19.0; found %s.\n' "$node_version" >&2
  exit 1
fi

if [ -z "$version" ] && [ "$default_version" != "__NAUSICAA_DEFAULT_VERSION__" ]; then
  version="$default_version"
fi
if [ -z "$version" ]; then
  registry="${NAUSICAA_NPM_REGISTRY:-https://registry.npmjs.org}"
  version=$(npm view "$package_name" version --registry "$registry")
fi
case "$version" in
  ''|*[!0-9A-Za-z.-]*)
    printf 'Invalid Nausicaa version: %s\n' "$version" >&2
    exit 1
    ;;
esac

registry="${NAUSICAA_NPM_REGISTRY:-https://registry.npmjs.org}"
printf 'Installing %s@%s with Node.js %s...\n' "$package_name" "$version" "$node_version"
npm install --global --omit=dev --registry "$registry" "$package_name@$version"
printf '\nNausicaa %s is installed. Run: nausicaa --help\n' "$version"
