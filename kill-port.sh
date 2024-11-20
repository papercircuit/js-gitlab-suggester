#!/bin/bash

PORT=3000

# Find and kill the process using the specified port
lsof -ti :$PORT | xargs kill -9

echo "Killed any processes running on port $PORT"