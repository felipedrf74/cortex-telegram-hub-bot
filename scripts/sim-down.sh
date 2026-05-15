#!/usr/bin/env bash
# sim-down.sh — stop iOS Simulator processes after local-dev runs.
#
# Keeps Docker sandbox/data untouched. This is intentionally the same cleanup
# posture used after full iOS test runs: shut down booted devices, quit the
# Simulator app, and trim SimulatorTrampoline/CoreSimulator memory.

set -euo pipefail

echo "Shutting down booted iOS simulators..."
xcrun simctl shutdown all 2>/dev/null || true

echo ""
echo "Booted devices after shutdown:"
xcrun simctl list devices booted 2>/dev/null || true

echo "Quitting Simulator.app..."
osascript -e 'tell application "Simulator" to quit' >/dev/null 2>&1 || true

echo "Trimming simulator helper processes..."
pkill -f 'Previews/Simulator Devices' 2>/dev/null || true
pkill -f 'SimulatorTrampoline' 2>/dev/null || true
pkill -f 'com.apple.CoreSimulator.CoreSimulatorService' 2>/dev/null || true
killall SimulatorTrampoline 2>/dev/null || true
killall com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
sleep 1

echo ""
echo "Remaining simulator processes:"
ps -axo pid,rss,comm | grep -E 'SimulatorTrampoline|CoreSimulatorService|Simulator.app' || true

echo "Simulator shutdown complete."
