#!/usr/bin/env bash
#
# glv — Project Setup Helper
#
#   1. Verifies prerequisites (Node.js, pnpm)
#   2. Installs Node dependencies
#   3. Symlinks the `glv` launcher onto the PATH
#
# Compatible with Linux and macOS. Windows is NOT supported — use WSL2.
#
# Usage:  ./setup.sh    (run from the repository root)
# Re-running is safe — every step is idempotent.

set -euo pipefail

# ─── Output helpers ───────────────────────────────────────────

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' GREEN=$'\033[32m' RED=$'\033[31m'
  YELLOW=$'\033[33m' BLUE=$'\033[34m' CYAN=$'\033[36m' RESET=$'\033[0m'
else
  BOLD="" DIM="" GREEN="" RED="" YELLOW="" BLUE="" CYAN="" RESET=""
fi

info()    { printf '%s▶%s %s\n'  "${BLUE}"   "${RESET}" "$*"; }
success() { printf '%s✔%s %s\n' "${GREEN}"  "${RESET}" "$*"; }
warn()    { printf '%s⚠%s %s\n' "${YELLOW}" "${RESET}" "$*"; }
error()   { printf '%s✘%s %s\n' "${RED}"    "${RESET}" "$*" >&2; }
die()     { error "$*"; exit 1; }

heading() {
  printf '\n%s━━━ %s ━━━%s\n' "${BOLD}${CYAN}" "$*" "${RESET}"
}

# ─── Utility functions ────────────────────────────────────────

command_exists() { command -v "$1" >/dev/null 2>&1; }

dir_on_path() {
  echo "$PATH" | tr ':' '\n' | grep -qx "$1"
}

major_version() {
  echo "$1" | sed 's/^v//' | cut -d. -f1
}

# ─── Step 0: Platform check ───────────────────────────────────

check_platform() {
  heading "Platform Check"
  local os_type
  os_type="$(uname -s)"
  case "$os_type" in
    Linux*|Darwin*)
      success "Running on $os_type"
      ;;
    MINGW*|MSYS*|CYGWIN*|*Windows*)
      die "Windows is not supported. Please use WSL2 (Ubuntu) or a Linux VM, then run this script from inside it."
      ;;
    *)
      die "Unrecognised platform '$os_type'. This script supports Linux and macOS only."
      ;;
  esac
}

# ─── Step 0a: Locate project root ─────────────────────────────

resolve_project_root() {
  heading "Locate Project Root"
  local script_dir
  script_dir="$(cd "$(dirname "$0")" && pwd)"

  if [ -f "$script_dir/package.json" ] && [ -f "$script_dir/bin/glv" ]; then
    PROJECT_ROOT="$script_dir"
  else
    die "Cannot find 'package.json' and 'bin/glv' relative to '$script_dir'. Please run this script from the repository root."
  fi
  info "Project root: $PROJECT_ROOT"
}

# ─── Step 1: Check prerequisites ──────────────────────────────

check_node() {
  heading "Checking for Node.js"

  if ! command_exists node; then
    echo ""
    echo "  Node.js (≥ 24) is required to run glv."
    die "Please install Node.js ≥ 24 and re-run this script."
  fi

  local node_version node_major
  node_version="$(node --version 2>/dev/null || echo 'unknown')"
  node_major="$(major_version "$node_version")"
  if [ "$node_major" -ge 24 ] 2>/dev/null; then
    success "Node.js found — $node_version (≥ 24 ✓)"
  else
    die "Node.js ≥ 24 is required (found $node_version)."
  fi
}

check_pnpm() {
  heading "Checking for pnpm"

  if ! command_exists pnpm; then
    die "pnpm (≥ 10) is required. Install it: npm install -g pnpm@latest"
  fi

  local pnpm_version pnpm_major
  pnpm_version="$(pnpm --version 2>/dev/null || echo 'unknown')"
  pnpm_major="$(major_version "$pnpm_version")"
  if [ "$pnpm_major" -ge 10 ] 2>/dev/null; then
    success "pnpm found — v$pnpm_version (≥ 10 ✓)"
  else
    die "Please upgrade pnpm to ≥ 10 (found v$pnpm_version)."
  fi
}

# ─── Step 2: Install Node dependencies ────────────────────────

install_node_dependencies() {
  heading "Installing Node Dependencies (pnpm install)"

  info "Working directory: $PROJECT_ROOT"
  cd "$PROJECT_ROOT"

  if [ -d "node_modules" ] && [ -f "pnpm-lock.yaml" ]; then
    info "node_modules exists — running pnpm install to ensure everything is current..."
  else
    info "Running pnpm install (first time)..."
  fi

  if pnpm install --frozen-lockfile 2>/dev/null || pnpm install; then
    success "Dependencies installed"
  else
    die "pnpm install failed. See output above."
  fi
}

# ─── Step 3: Create `glv` symlink ─────────────────────────────

setup_glv_symlink() {
  heading "Setting Up \`glv\` Command"

  local bin_dir="$HOME/.local/bin"
  local glv_bin="$PROJECT_ROOT/bin/glv"
  local symlink_path="$bin_dir/glv"

  BIN_DIR="$bin_dir"
  SYMLINK_PATH="$symlink_path"

  mkdir -p "$bin_dir"

  if ! dir_on_path "$bin_dir"; then
    warn "$bin_dir is not on your PATH."
    echo ""
    echo "  Add this line to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo "    export PATH=\"$bin_dir:\$PATH\""
    echo ""
    echo "  Then restart your terminal or run: source ~/.bashrc (or ~/.zshrc)"
    echo ""
  fi

  if [ -L "$symlink_path" ] && [ "$(readlink "$symlink_path" 2>/dev/null || true)" = "$glv_bin" ]; then
    success "Symlink already correct — $symlink_path → $glv_bin"
  else
    if [ -e "$symlink_path" ] || [ -L "$symlink_path" ]; then
      info "Updating existing symlink to point to this project..."
      rm -f "$symlink_path"
      ln -s "$glv_bin" "$symlink_path"
      success "Symlink updated — $symlink_path → $glv_bin"
    else
      ln -s "$glv_bin" "$symlink_path"
      success "Symlink created — $symlink_path → $glv_bin"
    fi
  fi
}

# ─── Done ─────────────────────────────────────────────────────

print_next_steps() {
  heading "Setup Complete!"

  echo ""
  printf '%sglv is ready to use!%s\n' "${BOLD}${GREEN}" "${RESET}"
  echo ""
  echo "  Get started:"
  echo ""
  echo "    ${BOLD}glv sessions${RESET}            # list recent goose sessions"
  echo "    ${BOLD}glv view <id>${RESET}           # show prompts + outputs for a session"
  echo "    ${BOLD}glv logs${RESET}                # list --no-session runs"
  echo ""
  if ! dir_on_path "$BIN_DIR"; then
    echo "  ${YELLOW}Note:${RESET} $BIN_DIR is not on your PATH."
    echo "  Add it to your shell profile or invoke glv via the full path:"
    echo "    $SYMLINK_PATH sessions"
    echo ""
  fi
}

# ─── Main ─────────────────────────────────────────────────────

main() {
  check_platform
  resolve_project_root
  check_node
  check_pnpm
  install_node_dependencies
  setup_glv_symlink
  print_next_steps
}

main "$@"
