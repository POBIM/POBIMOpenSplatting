#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/dist/prebuilt-runtime}"
STAGING_DIR="$OUTPUT_DIR/staging"

mkdir -p "$OUTPUT_DIR"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

copy_if_exists() {
    local source_path="$1"
    local target_path="$2"

    if [ -e "$source_path" ]; then
        mkdir -p "$(dirname "$target_path")"
        cp -a "$source_path" "$target_path"
        echo "Included: ${source_path#$REPO_ROOT/}"
    else
        echo "Missing:   ${source_path#$REPO_ROOT/}"
    fi
}

copy_tree_filtered() {
    local source_dir="$1"
    local target_dir="$2"
    shift 2

    if [ ! -d "$source_dir" ]; then
        echo "Missing:   ${source_dir#$REPO_ROOT/}"
        return 0
    fi

    mkdir -p "$target_dir"
    while IFS= read -r rel_path; do
        mkdir -p "$(dirname "$target_dir/$rel_path")"
        cp -a "$source_dir/$rel_path" "$target_dir/$rel_path"
        echo "Included: ${source_dir#$REPO_ROOT/}/$rel_path"
    done < <(cd "$source_dir" && find "$@" -type f | sort)
}

copy_if_exists "$REPO_ROOT/build/opensplat" "$STAGING_DIR/build/opensplat"
copy_if_exists "$REPO_ROOT/build/simple_trainer" "$STAGING_DIR/build/simple_trainer"

copy_if_exists "$REPO_ROOT/colmap-build/install/bin/colmap" "$STAGING_DIR/colmap-build/install/bin/colmap"
copy_if_exists "$REPO_ROOT/colmap-build/src/glomap/glomap" "$STAGING_DIR/colmap-build/src/glomap/glomap"
copy_tree_filtered \
    "$REPO_ROOT/colmap-build/install/lib" \
    "$STAGING_DIR/colmap-build/install/lib" \
    -name '*.so' -o -name '*.so.*'

copy_if_exists "$REPO_ROOT/fastmap/run.py" "$STAGING_DIR/fastmap/run.py"
copy_tree_filtered \
    "$REPO_ROOT/fastmap/fastmap" \
    "$STAGING_DIR/fastmap/fastmap" \
    -name '*.py' -o -name '*.so'

copy_if_exists "$REPO_ROOT/hloc/setup.py" "$STAGING_DIR/hloc/setup.py"
copy_if_exists "$REPO_ROOT/hloc/requirements.txt" "$STAGING_DIR/hloc/requirements.txt"
copy_tree_filtered \
    "$REPO_ROOT/hloc/hloc" \
    "$STAGING_DIR/hloc/hloc" \
    -name '*.py'

cat > "$STAGING_DIR/MANIFEST.txt" <<'EOF'
This archive contains prebuilt runtime artifacts intended to be extracted at the repository root.

Included components:
- build/opensplat
- build/simple_trainer
- colmap-build/install/bin/colmap
- colmap-build/install/lib/*.so*
- colmap-build/src/glomap/glomap
- fastmap/run.py
- fastmap/fastmap/*.py
- fastmap/fastmap/*.so
- hloc/setup.py
- hloc/requirements.txt
- hloc/hloc/*.py

Notes:
- Extract this archive at the repository root so relative paths match Backend/core/config.py.
- This package does not include Python/Node virtual environments, frontend build artifacts, uploads, results, or model weights.
- Runtime compatibility still depends on matching OS, glibc, CUDA/ROCm, and GPU driver versions.
EOF

ARCHIVE_PATH="$OUTPUT_DIR/prebuilt-runtime-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -C "$STAGING_DIR" -czf "$ARCHIVE_PATH" .

echo
echo "Created archive:"
echo "  $ARCHIVE_PATH"
echo
echo "Extract at repo root with:"
echo "  tar -xzf $(basename "$ARCHIVE_PATH") -C /path/to/POBIMOpenSplatting"
