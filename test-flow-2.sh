#!/bin/bash

echo "Testing the 2nd lock-mint demo flow"

# Start bridge monitor in background
npm run bridge-monitor &
MONITOR_PID=$!

# Wait for monitor to initialize
sleep 10

echo "Triggering new lock transaction..."
npm run demo-lock 0.001 '[SHA256]15ed2f7f97c6e98c15d8dc4ba8bef3ebefc5ebf049dab7cdd075d334a6bba2f9' &

# Wait for processing
sleep 30

echo "Stopping bridge monitor..."
kill $MONITOR_PID

echo "Generated files..."
ls -la demo-output/

echo "Validating generated Unicity tokens..."

for token_file in demo-output/unicity-token-*.json; do
    npm run validate-token "$token_file"
done
