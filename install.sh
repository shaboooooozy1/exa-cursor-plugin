#!/usr/bin/env bash
# install.sh — install the Exa plugin for Cursor
#
# Usage:
#   bash install.sh              # install
#   bash install.sh --uninstall  # remove
#
# Copies the plugin to ~/.cursor/plugins/local/exa/ and registers it
# in ~/.claude/ so Cursor discovers it on next restart.

set -euo pipefail

PLUGIN_NAME="exa"
PLUGIN_ID="${PLUGIN_NAME}@local"
PLUGIN_DIR="${HOME}/.cursor/plugins/local/${PLUGIN_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLAUDE_DIR="${HOME}/.claude"
CLAUDE_PLUGINS="${CLAUDE_DIR}/plugins/installed_plugins.json"
CLAUDE_SETTINGS="${CLAUDE_DIR}/settings.json"

COMPONENTS=(
  ".cursor-plugin"
  "skills"
  "commands"
  "rules"
  "assets"
  "mcp.json"
)

# Upsert a plugin entry into a JSON file without clobbering other plugins.
# Requires python3 (ships with macOS and most Linux).
# Values are passed to python as argv, never interpolated into the source.
# Writes go to <realpath>.tmp then os.replace(), so a symlinked settings file
# (dotfiles managers) keeps its link and its target is updated in place, and
# the target's existing mode is preserved.
json_upsert() {
  local file="$1" script="$2"
  shift 2
  command -v python3 >/dev/null 2>&1 || { echo "  ⚠ python3 not found — skipping ${file}"; return; }
  mkdir -p "$(dirname "$file")"
  python3 -c "$script" "$file" "$@"
}

uninstall() {
  # Remove plugin files
  if [ -d "$PLUGIN_DIR" ]; then
    rm -rf "$PLUGIN_DIR"
    echo "Removed ${PLUGIN_DIR}"
  else
    echo "Plugin not found at ${PLUGIN_DIR} — nothing to remove."
  fi

  # Remove .claude registration
  json_upsert "$CLAUDE_PLUGINS" '
import json, os, shutil, sys
path, plugin_id = sys.argv[1:3]
if not os.path.exists(path): sys.exit(0)
with open(path) as f: data = json.load(f)
plugins = data.get("plugins", {})
plugins.pop(plugin_id, None)
data["plugins"] = plugins
real = os.path.realpath(path)
tmp = real + ".tmp"
with open(tmp, "w") as f: json.dump(data, f, indent=2)
if os.path.exists(real): shutil.copymode(real, tmp)
os.replace(tmp, real)
' "$PLUGIN_ID"
  json_upsert "$CLAUDE_SETTINGS" '
import json, os, shutil, sys
path, plugin_id = sys.argv[1:3]
if not os.path.exists(path): sys.exit(0)
with open(path) as f: data = json.load(f)
data.get("enabledPlugins", {}).pop(plugin_id, None)
real = os.path.realpath(path)
tmp = real + ".tmp"
with open(tmp, "w") as f: json.dump(data, f, indent=2)
if os.path.exists(real): shutil.copymode(real, tmp)
os.replace(tmp, real)
' "$PLUGIN_ID"

  echo "Restart Cursor to apply."
}

install() {
  # 1. Copy plugin files
  [ -d "$PLUGIN_DIR" ] && rm -rf "$PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR"

  for component in "${COMPONENTS[@]}"; do
    src="${SCRIPT_DIR}/${component}"
    [ -e "$src" ] && cp -R "$src" "$PLUGIN_DIR/${component}"
  done
  echo "Copied plugin to ${PLUGIN_DIR}"

  # 2. Register in ~/.claude/plugins/installed_plugins.json
  json_upsert "$CLAUDE_PLUGINS" '
import json, os, shutil, sys
path, plugin_id, plugin_dir = sys.argv[1:4]
data = {}
if os.path.exists(path):
    with open(path) as f: raw = f.read()
    if raw.strip():
        try: data = json.loads(raw)
        except ValueError: raise SystemExit("refusing to rewrite " + path + ": not valid JSON")
if not isinstance(data, dict): raise SystemExit("refusing to rewrite " + path + ": top-level value is not an object")
plugins = data.get("plugins", {})
entries = [e for e in plugins.get(plugin_id, [])
           if not (isinstance(e, dict) and e.get("scope") == "user")]
entries.insert(0, {"scope": "user", "installPath": plugin_dir})
plugins[plugin_id] = entries
data["plugins"] = plugins
real = os.path.realpath(path)
tmp = real + ".tmp"
with open(tmp, "w") as f: json.dump(data, f, indent=2)
if os.path.exists(real): shutil.copymode(real, tmp)
os.replace(tmp, real)
' "$PLUGIN_ID" "$PLUGIN_DIR"

  # 3. Enable in ~/.claude/settings.json
  json_upsert "$CLAUDE_SETTINGS" '
import json, os, shutil, sys
path, plugin_id = sys.argv[1:3]
data = {}
if os.path.exists(path):
    with open(path) as f: raw = f.read()
    if raw.strip():
        try: data = json.loads(raw)
        except ValueError: raise SystemExit("refusing to rewrite " + path + ": not valid JSON")
if not isinstance(data, dict): raise SystemExit("refusing to rewrite " + path + ": top-level value is not an object")
data.setdefault("enabledPlugins", {})[plugin_id] = True
real = os.path.realpath(path)
tmp = real + ".tmp"
with open(tmp, "w") as f: json.dump(data, f, indent=2)
if os.path.exists(real): shutil.copymode(real, tmp)
os.replace(tmp, real)
' "$PLUGIN_ID"

  echo ""
  echo "Installed. Next steps:"
  echo "  1. Restart Cursor (or Cmd/Ctrl+Shift+P → Developer: Reload Window)"
  echo "  2. If prompted, enable 'Include third-party Plugins' in Settings → Features"
  echo "  3. The plugin should appear under Settings → Plugins"
}

case "${1:-}" in
  --uninstall) uninstall ;;
  *)           install ;;
esac
