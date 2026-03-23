#!/bin/bash
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/rebuild-colmap-with-cuda.sh" "$@"
