#!/usr/bin/env bash
set -euo pipefail

repo=${AETHON_REPO:-/repo}
package_root=${AUR_PACKAGE_ROOT:-${repo}/packaging/aur}
build_root=${AUR_BUILD_ROOT:-/tmp/aethon-aur-build}

if [[ ! -d "${package_root}" ]]; then
  printf 'error: AUR package root not found: %s\n' "${package_root}" >&2
  exit 1
fi

rm -rf "${build_root}"
mkdir -p "${build_root}"

shopt -s nullglob
packages=()
for dir in "${package_root}"/*; do
  [[ -d "${dir}" && -f "${dir}/PKGBUILD" ]] || continue
  packages+=("${dir}")
done

if (( ${#packages[@]} == 0 )); then
  printf 'error: no AUR package directories found under %s\n' "${package_root}" >&2
  exit 1
fi

for dir in "${packages[@]}"; do
  name=$(basename "${dir}")
  work="${build_root}/${name}"

  printf '==> Building AUR package: %s\n' "${name}"
  mkdir -p "${work}"
  cp -a "${dir}/." "${work}/"

  (
    cd "${work}"
    makepkg --syncdeps --noconfirm --needed --clean --cleanbuild --force
  )
done

printf '==> Built %d AUR package(s) cleanly. Artifacts are under %s\n' \
  "${#packages[@]}" "${build_root}"
