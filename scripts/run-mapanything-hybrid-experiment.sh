#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ID="${PROJECT_ID:-628e0f34-331b-4d78-be13-1d595e2662d8}"
SOURCE_PROJECT="${SOURCE_PROJECT:-$REPO_ROOT/PobimSplatting/Backend/uploads/$PROJECT_ID}"
EXPERIMENT_ROOT="${EXPERIMENT_ROOT:-$REPO_ROOT/PobimSplatting/Backend/experiments/mapanything_628e0f34}"
RESULTS_ROOT="${RESULTS_ROOT:-$EXPERIMENT_ROOT/results}"
LOG_DIR="${LOG_DIR:-$EXPERIMENT_ROOT/logs}"

MAPANYTHING_DIR="${MAPANYTHING_DIR:-/home/pobimgroup/tools/map-anything}"
MAPANYTHING_VENV="${MAPANYTHING_VENV:-/home/pobimgroup/venvs/mapanything}"
MAPANYTHING_TAG="${MAPANYTHING_TAG:-v1.1.1}"

OPENSPLAT_BIN="${OPENSPLAT_BIN:-$REPO_ROOT/build/opensplat}"
VOXEL_FRACTION="${VOXEL_FRACTION:-0.002}"
SHORT_ITERATIONS="${SHORT_ITERATIONS:-1200}"
FULL_ITERATIONS="${FULL_ITERATIONS:-8400}"
B_MAX_IMAGES="${B_MAX_IMAGES:-0}"
C_STRIDE="${C_STRIDE:-1}"
MAPANYTHING_C_EXTRA_ARGS="${MAPANYTHING_C_EXTRA_ARGS:-}"
MAPANYTHING_B_EXTRA_ARGS="${MAPANYTHING_B_EXTRA_ARGS:-}"

RUN_B="${RUN_B:-1}"
RUN_C="${RUN_C:-1}"
RUN_TRAINING="${RUN_TRAINING:-1}"
RUN_FULL="${RUN_FULL:-0}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"

export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

log() {
    printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$*"
}

die() {
    log "ERROR: $*"
    exit 1
}

run_logged() {
    local name="$1"
    shift
    mkdir -p "$LOG_DIR"
    log "Running $name"
    {
        printf '[%s] Command:' "$(date --iso-8601=seconds)"
        printf ' %q' "$@"
        printf '\n'
        "$@"
    } 2>&1 | tee "$LOG_DIR/$name.log"
}

python_bin() {
    printf '%s/bin/python' "$MAPANYTHING_VENV"
}

ensure_inputs() {
    [[ -d "$SOURCE_PROJECT/images" ]] || die "Missing source images: $SOURCE_PROJECT/images"
    [[ -d "$SOURCE_PROJECT/sparse/0" ]] || die "Missing source sparse model: $SOURCE_PROJECT/sparse/0"
    [[ -x "$OPENSPLAT_BIN" ]] || die "Missing OpenSplat binary: $OPENSPLAT_BIN"
    command -v git >/dev/null || die "git is required"
    command -v colmap >/dev/null || die "colmap is required"
    command -v python3.12 >/dev/null || command -v python3 >/dev/null || die "python3.12 or python3 is required"
}

setup_mapanything() {
    if [[ "$SKIP_INSTALL" == "1" ]]; then
        log "Skipping MapAnything install because SKIP_INSTALL=1"
        return
    fi

    mkdir -p "$(dirname "$MAPANYTHING_DIR")" "$(dirname "$MAPANYTHING_VENV")"
    if [[ ! -d "$MAPANYTHING_DIR/.git" ]]; then
        run_logged clone_mapanything git clone https://github.com/facebookresearch/map-anything.git "$MAPANYTHING_DIR"
    else
        run_logged fetch_mapanything git -C "$MAPANYTHING_DIR" fetch --tags origin
    fi
    run_logged checkout_mapanything git -C "$MAPANYTHING_DIR" checkout "$MAPANYTHING_TAG"

    if [[ ! -x "$MAPANYTHING_VENV/bin/python" ]]; then
        local py
        py="$(command -v python3.12 || command -v python3)"
        run_logged create_mapanything_venv "$py" -m venv "$MAPANYTHING_VENV"
    fi

    run_logged install_mapanything_pip "$(python_bin)" -m pip install --upgrade pip setuptools wheel
    run_logged install_mapanything_colmap "$(python_bin)" -m pip install -e "$MAPANYTHING_DIR[colmap]"
}

prepare_layout() {
    mkdir -p "$EXPERIMENT_ROOT" "$RESULTS_ROOT" "$LOG_DIR"
    ln -sfn "$SOURCE_PROJECT" "$EXPERIMENT_ROOT/a_colmap_baseline"

    local c_input="$EXPERIMENT_ROOT/c_colmap_input"
    mkdir -p "$c_input"
    ln -sfn "$SOURCE_PROJECT/images" "$c_input/images"
    rm -rf "$c_input/sparse"
    mkdir -p "$c_input/sparse"
    cp -a "$SOURCE_PROJECT/sparse/0/." "$c_input/sparse/"
}

run_preflight() {
    run_logged preflight_nvidia_smi bash -lc 'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || true'
    run_logged preflight_torch "$(python_bin)" - <<'PY'
import torch
print("torch", torch.__version__)
print("cuda_available", torch.cuda.is_available())
if torch.cuda.is_available():
    print("device", torch.cuda.get_device_name(0))
    print("capability", torch.cuda.get_device_capability(0))
PY
    run_logged preflight_colmap_help bash -lc "cd '$MAPANYTHING_DIR' && '$MAPANYTHING_VENV/bin/python' scripts/demo_inference_on_colmap_outputs.py --help"
    run_logged analyze_a_colmap colmap model_analyzer --path "$SOURCE_PROJECT/sparse/0"
}

normalize_colmap_project() {
    local raw_output="$1"
    local project_output="$2"
    local sparse_source=""
    local images_source=""

    if [[ -d "$raw_output/sparse/0" ]]; then
        sparse_source="$raw_output/sparse/0"
    elif [[ -f "$raw_output/sparse/cameras.bin" ]]; then
        sparse_source="$raw_output/sparse"
    elif [[ -f "$raw_output/cameras.bin" ]]; then
        sparse_source="$raw_output"
    fi

    if [[ -d "$raw_output/images" ]]; then
        images_source="$raw_output/images"
    else
        images_source="$SOURCE_PROJECT/images"
    fi

    [[ -n "$sparse_source" ]] || die "Could not find COLMAP sparse output under $raw_output"
    [[ -d "$images_source" ]] || die "Could not find images for $raw_output"

    rm -rf "$project_output"
    mkdir -p "$project_output/sparse"
    ln -sfn "$images_source" "$project_output/images"
    cp -a "$sparse_source" "$project_output/sparse/0"
}

run_b_mapanything_only() {
    local raw="$EXPERIMENT_ROOT/b_mapanything_image_only"
    local project="$EXPERIMENT_ROOT/b_opensplat_project"
    local b_images
    b_images="$(prepare_b_images)"
    if [[ -f "$raw/sparse/cameras.bin" || -f "$raw/sparse/0/cameras.bin" ]]; then
        log "Skipping B inference because existing COLMAP output was found"
    else
        mkdir -p "$raw"
        run_logged b_mapanything_image_only bash -lc "cd '$MAPANYTHING_DIR' && '$MAPANYTHING_VENV/bin/python' scripts/demo_colmap.py --images_dir '$b_images' --output_dir '$raw' --voxel_fraction '$VOXEL_FRACTION' --save_glb $MAPANYTHING_B_EXTRA_ARGS"
    fi
    normalize_colmap_project "$raw" "$project"
    run_logged analyze_b_colmap colmap model_analyzer --path "$project/sparse/0"
    train_variant "b" "$project" "$SHORT_ITERATIONS"
    if [[ "$RUN_FULL" == "1" ]]; then
        train_variant "b" "$project" "$FULL_ITERATIONS"
    fi
}

run_c_colmap_guided() {
    local staged="$EXPERIMENT_ROOT/c_colmap_input"
    local raw="$EXPERIMENT_ROOT/c_colmap_guided_mapanything"
    local project="$EXPERIMENT_ROOT/c_opensplat_project"
    if [[ -f "$raw/sparse/cameras.bin" || -f "$raw/sparse/0/cameras.bin" ]]; then
        log "Skipping C inference because existing COLMAP output was found"
    else
        mkdir -p "$raw"
        run_logged c_colmap_guided_mapanything bash -lc "cd '$MAPANYTHING_DIR' && '$MAPANYTHING_VENV/bin/python' scripts/demo_inference_on_colmap_outputs.py --colmap_path '$staged' --save_colmap --save_glb --output_directory '$raw' --stride '$C_STRIDE' $MAPANYTHING_C_EXTRA_ARGS"
    fi
    normalize_colmap_project "$raw" "$project"
    run_logged analyze_c_colmap colmap model_analyzer --path "$project/sparse/0"
    train_variant "c" "$project" "$SHORT_ITERATIONS"
    if [[ "$RUN_FULL" == "1" ]]; then
        train_variant "c" "$project" "$FULL_ITERATIONS"
    fi
}

prepare_b_images() {
    if [[ "$B_MAX_IMAGES" == "0" ]]; then
        printf '%s/images\n' "$SOURCE_PROJECT"
        return
    fi

    local subset="$EXPERIMENT_ROOT/b_image_subset_${B_MAX_IMAGES}"
    rm -rf "$subset"
    mkdir -p "$subset"
    find "$SOURCE_PROJECT/images" -maxdepth 1 -type f \
        \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) \
        | sort \
        | head -n "$B_MAX_IMAGES" \
        | while IFS= read -r image_path; do
            ln -s "$image_path" "$subset/$(basename "$image_path")"
        done
    log "B image-only subset: $(find "$subset" -maxdepth 1 -type l | wc -l) images at $subset" >&2
    printf '%s\n' "$subset"
}

train_variant() {
    local variant="$1"
    local project="$2"
    local iterations="$3"

    if [[ "$RUN_TRAINING" != "1" ]]; then
        log "Skipping $variant training because RUN_TRAINING=$RUN_TRAINING"
        return
    fi

    local out_dir="$RESULTS_ROOT/${variant}_${iterations}iter"
    local out_ply="$out_dir/${variant}_${iterations}iter.ply"
    mkdir -p "$out_dir"
    if [[ -f "$out_ply" ]]; then
        log "Skipping $variant $iterations iteration training because $out_ply exists"
        return
    fi

    run_logged "train_${variant}_${iterations}iter" "$OPENSPLAT_BIN" "$project" -n "$iterations" --output "$out_ply"
}

collect_metrics() {
    run_logged collect_metrics python3 "$REPO_ROOT/scripts/collect-mapanything-hybrid-metrics.py" \
        --experiment-root "$EXPERIMENT_ROOT" \
        --source-project "$SOURCE_PROJECT" \
        --results-root "$RESULTS_ROOT"
}

main() {
    ensure_inputs
    setup_mapanything
    prepare_layout
    run_preflight
    if [[ "$RUN_B" == "1" ]]; then
        run_b_mapanything_only
    fi
    if [[ "$RUN_C" == "1" ]]; then
        run_c_colmap_guided
    fi
    collect_metrics
    log "Done. Experiment root: $EXPERIMENT_ROOT"
}

main "$@"
