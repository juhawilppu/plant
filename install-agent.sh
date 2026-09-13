#!/bin/sh
# Installs the fake-node publisher as a LaunchAgent that runs every 5 minutes.
#
# Why not cron, and why not run it from the repo: macOS TCC (System Integrity's
# privacy layer) denies scheduled jobs read access to ~/Documents, ~/Desktop and
# ~/Downloads. Verified both ways on this machine - cron and a LaunchAgent both
# got "Operation not permitted" / "Sandbox: deny file-read-data" on a script
# living under ~/Documents. The alternative would be granting Full Disk Access
# to cron or /bin/sh, which is a far broader permission than this job deserves.
#
# So the runtime copy lives in ~/Library/Application Support, which TCC does not
# guard, and the repo stays the source of truth. Re-run this after changing
# publish-fake-reading.sh or fake-node.js.
#
#   ./install-agent.sh          install or update, and start it
#   ./install-agent.sh --remove uninstall
set -e
cd "$(dirname "$0")"

LABEL=com.juhawilppu.plant-vitals-fake-node
DEST="$HOME/Library/Application Support/plant-vitals"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$1" = "--remove" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    rm -rf "$DEST"
    echo "removed $LABEL"
    exit 0
fi

[ -f "$HOME/.config/plant-vitals/env" ] || {
    echo "missing ~/.config/plant-vitals/env - create it with MQTT_URL and MQTT_NODE_PASSWORD" >&2
    exit 1
}

# The layout under DEST mirrors the repo, so the wrapper's relative path to
# server/fake-node.js works unchanged in both places.
mkdir -p "$DEST/server"
cp publish-fake-reading.sh "$DEST/publish-fake-reading.sh"
chmod +x "$DEST/publish-fake-reading.sh"
cp server/fake-node.js "$DEST/server/fake-node.js"
rsync -a --delete server/node_modules/ "$DEST/server/node_modules/"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$DEST/publish-fake-reading.sh</string>
    </array>
    <!-- Every 5 minutes. launchd also fires shortly after the Mac wakes, where
         cron would simply have missed the slot. -->
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/plant-vitals-agent.out.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/plant-vitals-agent.err.log</string>
</dict>
</plist>
PLISTEOF

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL - publishing every 300s"
echo "  runtime copy: $DEST"
echo "  log:          $HOME/Library/Logs/plant-vitals-fake-node.log"
