#!/bin/bash

# Shared helpers for building CUDA-enabled Ceres + COLMAP consistently.

: "${COLMAP_CERES_VERSION:=master}"
: "${COLMAP_CERES_MIN_CUDSS_VERSION:=2.3.0}"
: "${COLMAP_SOURCE_URL:=https://github.com/colmap/colmap.git}"
: "${COLMAP_SOURCE_REF:=}"
: "${COLMAP_ENABLE_CUDSS:=auto}"

colmap_common_info() {
    if declare -F print_info >/dev/null 2>&1; then
        print_info "$1"
    else
        echo -e "${CYAN}ℹ $1${NC}"
    fi
}

colmap_common_success() {
    if declare -F print_success >/dev/null 2>&1; then
        print_success "$1"
    else
        echo -e "${GREEN}✓ $1${NC}"
    fi
}

colmap_common_warning() {
    if declare -F print_warning >/dev/null 2>&1; then
        print_warning "$1"
    else
        echo -e "${YELLOW}⚠ $1${NC}"
    fi
}

colmap_common_error() {
    if declare -F print_error >/dev/null 2>&1; then
        print_error "$1"
    else
        echo -e "${RED}✗ $1${NC}"
    fi
}

colmap_require_cmake() {
    local required_version="${1:-3.24.0}"
    local current_version

    if ! command -v cmake >/dev/null 2>&1; then
        colmap_common_error "CMake is not installed"
        return 1
    fi

    current_version=$(cmake --version | head -n1 | sed -n 's/^cmake version //p')
    if [[ -z "$current_version" ]] || [[ "$(printf '%s\n' "$required_version" "$current_version" | sort -V | head -n1)" != "$required_version" ]]; then
        colmap_common_error "CMake $current_version is too old"
        return 1
    fi

    return 0
}

colmap_detect_cuda_home() {
    if [ -n "${CUDA_HOME:-}" ] && [ -f "$CUDA_HOME/bin/nvcc" ]; then
        printf '%s' "$CUDA_HOME"
        return 0
    fi

    local cuda_paths=(
        "/usr/local/cuda-13.0"
        "/usr/local/cuda"
        "/usr/local/cuda-12.6"
        "/usr/local/cuda-12.5"
        "/usr/local/cuda-12.4"
        "/usr/local/cuda-12.3"
        "/usr/local/cuda-12.1"
        "/usr/local/cuda-11.8"
        "/opt/cuda"
    )
    local cuda_path

    for cuda_path in "${cuda_paths[@]}"; do
        if [ -d "$cuda_path" ] && [ -f "$cuda_path/bin/nvcc" ]; then
            printf '%s' "$cuda_path"
            return 0
        fi
    done

    return 1
}

colmap_detect_gpu_archs() {
    local default_archs="${1:-75;80;86;89}"
    local detected_archs="$default_archs"
    local compute_cap=""
    local cuda_major=""
    local filtered_archs=""
    local arch

    if [ -n "${CUDA_HOME:-}" ] && [ -x "$CUDA_HOME/bin/nvcc" ]; then
        cuda_major=$("$CUDA_HOME/bin/nvcc" --version | sed -n 's/.*release \([0-9][0-9]*\).*/\1/p' | head -n1)
    fi

    if [[ "$cuda_major" =~ ^[0-9]+$ ]] && [ "$cuda_major" -ge 13 ]; then
        IFS=';' read -ra arch_list <<< "$detected_archs"
        for arch in "${arch_list[@]}"; do
            if [[ "$arch" =~ ^[0-9]+$ ]] && [ "$arch" -ge 75 ]; then
                if [ -n "$filtered_archs" ]; then
                    filtered_archs="$filtered_archs;$arch"
                else
                    filtered_archs="$arch"
                fi
            fi
        done
        detected_archs="${filtered_archs:-75;80;86;89}"
    fi

    if command -v nvidia-smi >/dev/null 2>&1; then
        compute_cap=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n1 | tr -d '.')
        if [[ -n "$compute_cap" ]] && [[ ! "$detected_archs" =~ (^|;)"$compute_cap"($|;) ]]; then
            detected_archs="$detected_archs;$compute_cap"
        fi
    fi

    printf '%s' "$detected_archs"
}

colmap_version_ge() {
    local lhs="$1"
    local rhs="$2"

    if [ -z "$lhs" ] || [ -z "$rhs" ]; then
        return 1
    fi

    [ "$(printf '%s\n%s\n' "$rhs" "$lhs" | sort -V | head -n1)" = "$rhs" ]
}

colmap_cuda_major_version() {
    local cuda_home="${1:-${CUDA_HOME:-}}"

    [ -n "$cuda_home" ] && [ -x "$cuda_home/bin/nvcc" ] || return 1
    "$cuda_home/bin/nvcc" --version | sed -n 's/.*release \([0-9][0-9]*\).*/\1/p' | head -n1
}

colmap_cudss_enabled_for_cuda() {
    local cuda_home="${1:-${CUDA_HOME:-}}"
    local cuda_major

    case "$COLMAP_ENABLE_CUDSS" in
        1|ON|on|true|TRUE|yes|YES)
            return 0
            ;;
        0|OFF|off|false|FALSE|no|NO)
            return 1
            ;;
    esac

    cuda_major=$(colmap_cuda_major_version "$cuda_home" 2>/dev/null || true)
    if [[ "$cuda_major" =~ ^[0-9]+$ ]] && [ "$cuda_major" -ge 13 ]; then
        return 1
    fi

    return 0
}

colmap_sudo() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
        return $?
    fi

    if [ -n "${CUDA_SUDO_PASSWORD:-}" ]; then
        printf '%s\n' "$CUDA_SUDO_PASSWORD" | sudo -S "$@"
        return $?
    fi

    sudo "$@"
}

colmap_update_symlink() {
    local source_path="$1"
    local link_path="$2"

    if colmap_sudo ln -sf "$source_path" "$link_path"; then
        return 0
    fi

    [ "$(readlink -f "$link_path" 2>/dev/null)" = "$(readlink -f "$source_path")" ]
}

colmap_ceres_source_dir() {
    printf '%s/ceres-solver' "$1"
}

colmap_source_dir() {
    printf '%s/colmap' "$1"
}

colmap_recorded_source_ref() {
    local project_root="$1"
    local gitlink

    gitlink=$(git -C "$project_root" ls-tree HEAD colmap 2>/dev/null | awk '$1 == "160000" {print $3; exit}')
    if [ -n "$gitlink" ]; then
        printf '%s' "$gitlink"
        return 0
    fi

    return 1
}

colmap_ensure_source() {
    local project_root="$1"
    local source_dir
    local source_ref="${COLMAP_SOURCE_REF:-}"

    source_dir=$(colmap_source_dir "$project_root")
    if [ -f "$source_dir/CMakeLists.txt" ]; then
        return 0
    fi

    if [ -z "$source_ref" ]; then
        source_ref=$(colmap_recorded_source_ref "$project_root" || true)
    fi

    if [ -d "$source_dir" ] && [ -n "$(find "$source_dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
        colmap_common_error "COLMAP source at $source_dir is not empty but has no CMakeLists.txt"
        return 1
    fi

    colmap_common_info "Cloning COLMAP source repository..."
    git clone "$COLMAP_SOURCE_URL" "$source_dir" || return 1

    if [ -n "$source_ref" ]; then
        colmap_common_info "Checking out COLMAP ref $source_ref..."
        if git -C "$source_dir" fetch --depth 1 origin "$source_ref" >/dev/null 2>&1; then
            git -C "$source_dir" checkout --detach FETCH_HEAD >/dev/null 2>&1 || return 1
        elif git -C "$source_dir" rev-parse --verify -q "$source_ref^{commit}" >/dev/null 2>&1; then
            git -C "$source_dir" checkout --detach "$source_ref" >/dev/null 2>&1 || return 1
        else
            colmap_common_warning "Could not resolve COLMAP ref '$source_ref'; using default branch checkout"
        fi
    fi

    [ -f "$source_dir/CMakeLists.txt" ] || {
        colmap_common_error "COLMAP source clone did not produce $source_dir/CMakeLists.txt"
        return 1
    }
}

colmap_detect_cudss_lib_dir() {
    colmap_cudss_enabled_for_cuda "${CUDA_HOME:-}" || return 1

    local candidates=(
        "/usr/lib/x86_64-linux-gnu/libcudss/12"
        "/usr/lib64/libcudss/12"
        "/usr/local/cuda/lib64"
    )
    local candidate

    for candidate in "${candidates[@]}"; do
        if [ -f "$candidate/libcudss.so" ] || [ -f "$candidate/libcudss.so.0" ]; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    return 1
}

colmap_detect_cudss_cmake_dir() {
    colmap_cudss_enabled_for_cuda "${CUDA_HOME:-}" || return 1

    local candidates=(
        "/usr/lib/x86_64-linux-gnu/libcudss/12/cmake/cudss"
        "/usr/lib64/libcudss/12/cmake/cudss"
    )
    local candidate

    for candidate in "${candidates[@]}"; do
        if [ -f "$candidate/cudss-config.cmake" ]; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    return 1
}

colmap_prepare_cudss_cmake_shim() {
    local project_root="$1"
    local source_cmake_dir
    local source_lib_dir
    local shim_root
    local shim_cmake_dir
    local real_header_dir="/usr/include/libcudss/12"
    local lib_name

    colmap_cudss_enabled_for_cuda "${CUDA_HOME:-}" || return 1

    source_cmake_dir=$(colmap_detect_cudss_cmake_dir || true)
    source_lib_dir=$(colmap_detect_cudss_lib_dir || true)
    if [ -z "$source_cmake_dir" ] || [ -z "$source_lib_dir" ] || [ ! -d "$real_header_dir" ]; then
        return 1
    fi

    shim_root="$project_root/cudss-shim"
    shim_cmake_dir="$shim_root/12/cmake/cudss"

    mkdir -p "$shim_cmake_dir" "$shim_root/12"
    rm -rf "$shim_root/include"
    ln -s "$real_header_dir" "$shim_root/include"

    cp "$source_cmake_dir"/cudss-config.cmake \
       "$source_cmake_dir"/cudss-config-version.cmake \
       "$source_cmake_dir"/cudss-targets.cmake \
       "$source_cmake_dir"/cudss-targets-release.cmake \
       "$shim_cmake_dir"/ || return 1
    rm -f "$shim_cmake_dir"/cudss-static-targets.cmake "$shim_cmake_dir"/cudss-static-targets-release.cmake

    for lib_name in "$source_lib_dir"/libcudss*.so*; do
        if [ -e "$lib_name" ]; then
            ln -sfn "$lib_name" "$shim_root/12/$(basename "$lib_name")"
        fi
    done

    printf '%s' "$shim_cmake_dir"
}

colmap_ceres_build_dir() {
    printf '%s/ceres-build' "$1"
}

colmap_ceres_install_dir() {
    printf '%s/install' "$(colmap_ceres_build_dir "$1")"
}

colmap_ceres_cmake_dir() {
    local install_dir
    install_dir=$(colmap_ceres_install_dir "$1")
    if [ -d "$install_dir/lib/cmake/Ceres" ]; then
        printf '%s' "$install_dir/lib/cmake/Ceres"
        return 0
    fi
    if [ -d "$install_dir/lib64/cmake/Ceres" ]; then
        printf '%s' "$install_dir/lib64/cmake/Ceres"
        return 0
    fi
    return 1
}

colmap_ceres_lib_dir() {
    local install_dir
    install_dir=$(colmap_ceres_install_dir "$1")
    if [ -d "$install_dir/lib" ]; then
        printf '%s' "$install_dir/lib"
        return 0
    fi
    if [ -d "$install_dir/lib64" ]; then
        printf '%s' "$install_dir/lib64"
        return 0
    fi
    return 1
}

colmap_ceres_version_header() {
    local install_dir
    install_dir=$(colmap_ceres_install_dir "$1")
    [ -f "$install_dir/include/ceres/version.h" ] || return 1
    printf '%s' "$install_dir/include/ceres/version.h"
}

colmap_ceres_config_header() {
    local install_dir
    install_dir=$(colmap_ceres_install_dir "$1")
    [ -f "$install_dir/include/ceres/internal/config.h" ] || return 1
    printf '%s' "$install_dir/include/ceres/internal/config.h"
}

colmap_ceres_installed_version() {
    local version_header
    local major
    local minor
    local patch

    version_header=$(colmap_ceres_version_header "$1" 2>/dev/null) || return 1
    major=$(sed -n 's/^#define CERES_VERSION_MAJOR //p' "$version_header" | head -n1)
    minor=$(sed -n 's/^#define CERES_VERSION_MINOR //p' "$version_header" | head -n1)
    patch=$(sed -n 's/^#define CERES_VERSION_REVISION //p' "$version_header" | head -n1)

    if [ -z "$major" ] || [ -z "$minor" ] || [ -z "$patch" ]; then
        return 1
    fi

    printf '%s.%s.%s' "$major" "$minor" "$patch"
}

colmap_runtime_has_cudss() {
    colmap_cudss_enabled_for_cuda "${CUDA_HOME:-}" || return 1

    if ldconfig -p 2>/dev/null | grep -qi libcudss; then
        return 0
    fi

    colmap_detect_cudss_lib_dir >/dev/null 2>&1
}

colmap_ceres_has_cudss_support() {
    local config_header
    config_header=$(colmap_ceres_config_header "$1" 2>/dev/null) || return 1

    grep -q 'CERES_NO_CUDSS' "$config_header" || return 1
    if grep -Eq '^[[:space:]]*#define[[:space:]]+CERES_NO_CUDSS\b' "$config_header"; then
        return 1
    fi

    return 0
}

colmap_ceres_has_linuxbrew_refs() {
    local project_root="$1"
    local install_dir
    local build_dir
    local matches=()

    install_dir=$(colmap_ceres_install_dir "$project_root")
    build_dir=$(colmap_ceres_build_dir "$project_root")

    if rg -q '/home/linuxbrew/.linuxbrew' \
        "$build_dir/CMakeCache.txt" \
        "$install_dir/lib/cmake" \
        "$install_dir/lib64/cmake" 2>/dev/null; then
        return 0
    fi

    return 1
}

colmap_ceres_cuda_ready() {
    local project_root="$1"
    local cache_file
    local escaped_cuda_home
    local ceres_version
    cache_file="$(colmap_ceres_build_dir "$project_root")/CMakeCache.txt"
    [ -f "$cache_file" ] || return 1
    grep -Eq '^USE_CUDA:(BOOL|STRING)=ON$' "$cache_file" || return 1
    if [ -n "${CUDA_HOME:-}" ]; then
        escaped_cuda_home="${CUDA_HOME//\//\\/}"
        grep -Eq "^(CMAKE_CUDA_COMPILER:FILEPATH=${escaped_cuda_home}/bin/nvcc|CUDA_TOOLKIT_ROOT_DIR:[^=]+=${escaped_cuda_home})$" "$cache_file" || return 1
    fi
    colmap_ceres_cmake_dir "$project_root" >/dev/null 2>&1 || return 1
    colmap_ceres_has_linuxbrew_refs "$project_root" && return 1

    if colmap_runtime_has_cudss; then
        ceres_version=$(colmap_ceres_installed_version "$project_root" 2>/dev/null || true)
        colmap_version_ge "$ceres_version" "$COLMAP_CERES_MIN_CUDSS_VERSION" || return 1
        colmap_ceres_has_cudss_support "$project_root" || return 1
    elif colmap_ceres_has_cudss_support "$project_root"; then
        return 1
    fi

    return 0
}

colmap_clone_ceres_source() {
    local project_root="$1"
    local ceres_version="${2:-$COLMAP_CERES_VERSION}"
    local source_dir

    source_dir=$(colmap_ceres_source_dir "$project_root")

    if [ ! -d "$source_dir/.git" ]; then
        if [ -d "$source_dir" ]; then
            rm -rf "$source_dir"
        fi
        colmap_common_info "Cloning Ceres source repository..."
        git clone https://github.com/ceres-solver/ceres-solver.git "$source_dir" || return 1
    fi

    colmap_common_info "Updating Ceres source to ref $ceres_version..."
    if git -C "$source_dir" fetch --depth 1 origin "$ceres_version" >/dev/null 2>&1; then
        git -C "$source_dir" checkout --detach FETCH_HEAD >/dev/null 2>&1 || return 1
    elif git -C "$source_dir" rev-parse --verify -q "$ceres_version^{commit}" >/dev/null 2>&1; then
        git -C "$source_dir" checkout --detach "$ceres_version" >/dev/null 2>&1 || return 1
    else
        colmap_common_error "Could not resolve Ceres ref '$ceres_version'"
        return 1
    fi

    colmap_common_info "Using Ceres commit $(git -C "$source_dir" rev-parse --short HEAD)"
    git -C "$source_dir" submodule update --init --recursive --depth 1 third_party/abseil-cpp >/dev/null 2>&1 || return 1
    return 0
}

colmap_build_ceres_with_cuda() {
    local project_root="$1"
    local cuda_home="$2"
    local gpu_archs="$3"
    local num_cores="${4:-$(nproc)}"
    local ceres_version="${5:-$COLMAP_CERES_VERSION}"
    local source_dir
    local build_dir
    local install_dir
    local cmake_args
    local cudss_cmake_dir=""
    local cudss_lib_dir=""
    local extra_prefixes=""
    local extra_rpath=""
    local original_dir

    original_dir=$(pwd)

    if [ -z "$project_root" ] || [ -z "$cuda_home" ]; then
        colmap_common_error "colmap_build_ceres_with_cuda requires project_root and cuda_home"
        return 1
    fi

    if colmap_ceres_cuda_ready "$project_root"; then
        colmap_common_success "CUDA-enabled Ceres is already available"
        return 0
    fi

    source_dir=$(colmap_ceres_source_dir "$project_root")
    build_dir=$(colmap_ceres_build_dir "$project_root")
    install_dir=$(colmap_ceres_install_dir "$project_root")
    cudss_cmake_dir=$(colmap_prepare_cudss_cmake_shim "$project_root" || true)
    if [ -z "$cudss_cmake_dir" ]; then
        cudss_cmake_dir=$(colmap_detect_cudss_cmake_dir || true)
    fi
    cudss_lib_dir=$(colmap_detect_cudss_lib_dir || true)

    colmap_clone_ceres_source "$project_root" "$ceres_version" || return 1

    colmap_common_info "Building Ceres with CUDA support..."
    if [ -d "$build_dir" ]; then
        local backup_dir="${build_dir}.backup.$(date +%Y%m%d%H%M%S)"
        colmap_common_warning "Backing up existing Ceres build to $backup_dir"
        mv "$build_dir" "$backup_dir" || return 1
    fi
    mkdir -p "$build_dir"
    cd "$build_dir" || {
        cd "$original_dir" || true
        return 1
    }

    cmake_args=(
        "$source_dir"
        "-DCMAKE_BUILD_TYPE=Release"
        "-DCMAKE_INSTALL_PREFIX=$install_dir"
        "-DCMAKE_IGNORE_PREFIX_PATH=/home/linuxbrew/.linuxbrew"
        "-DUSE_CUDA=ON"
        "-DBUILD_TESTING=OFF"
        "-DBUILD_EXAMPLES=OFF"
        "-DLAPACK=ON"
        "-DSUITESPARSE=ON"
        "-DEigen3_DIR=/usr/share/eigen3/cmake"
        "-DCMAKE_POSITION_INDEPENDENT_CODE=ON"
        "-DCMAKE_CUDA_COMPILER=$cuda_home/bin/nvcc"
        "-DCUDA_TOOLKIT_ROOT_DIR=$cuda_home"
        "-DCMAKE_CUDA_ARCHITECTURES=$gpu_archs"
    )

    if colmap_cudss_enabled_for_cuda "$cuda_home" && [ -n "$cudss_cmake_dir" ]; then
        cmake_args+=("-Dcudss_DIR=$cudss_cmake_dir")
        extra_prefixes="$cudss_cmake_dir"
    else
        cmake_args+=("-DCMAKE_DISABLE_FIND_PACKAGE_cudss=ON")
    fi

    extra_rpath="$cuda_home/lib64"
    if colmap_cudss_enabled_for_cuda "$cuda_home" && [ -n "$cudss_lib_dir" ]; then
        extra_rpath="$extra_rpath;$cudss_lib_dir"
        if [ -n "$extra_prefixes" ]; then
            extra_prefixes="$extra_prefixes;$cudss_lib_dir"
        else
            extra_prefixes="$cudss_lib_dir"
        fi
    fi

    if [ -n "$extra_prefixes" ]; then
        cmake_args+=("-DCMAKE_PREFIX_PATH=$extra_prefixes")
    fi
    if [ -n "$extra_rpath" ]; then
        cmake_args+=(
            "-DCMAKE_BUILD_RPATH=$extra_rpath"
            "-DCMAKE_INSTALL_RPATH=$extra_rpath"
            "-DCMAKE_INSTALL_RPATH_USE_LINK_PATH=ON"
        )
    fi

    cmake "${cmake_args[@]}" || {
        cd "$original_dir" || true
        return 1
    }
    cmake --build . -j"$num_cores" || {
        cd "$original_dir" || true
        return 1
    }
    cmake --install . || {
        cd "$original_dir" || true
        return 1
    }

    if ! grep -Eq '^USE_CUDA:(BOOL|STRING)=ON$' "$build_dir/CMakeCache.txt"; then
        colmap_common_error "Ceres build completed without USE_CUDA=ON"
        cd "$original_dir" || true
        return 1
    fi

    if ! colmap_ceres_cmake_dir "$project_root" >/dev/null 2>&1; then
        colmap_common_error "Installed CUDA-enabled Ceres package config not found"
        cd "$original_dir" || true
        return 1
    fi

    local installed_version=""
    installed_version=$(colmap_ceres_installed_version "$project_root" 2>/dev/null || true)
    if [ -n "$installed_version" ]; then
        colmap_common_info "Installed Ceres version: $installed_version"
    fi

    if colmap_runtime_has_cudss; then
        if ! colmap_version_ge "$installed_version" "$COLMAP_CERES_MIN_CUDSS_VERSION"; then
            colmap_common_error "Installed Ceres $installed_version is too old for cuDSS sparse GPU BA (need >= $COLMAP_CERES_MIN_CUDSS_VERSION)"
            cd "$original_dir" || true
            return 1
        fi
        if ! colmap_ceres_has_cudss_support "$project_root"; then
            colmap_common_error "Ceres build completed without cuDSS sparse solver support"
            cd "$original_dir" || true
            return 1
        fi
        colmap_common_success "cuDSS sparse GPU BA support is enabled in Ceres"
    else
        colmap_common_warning "cuDSS runtime not found; dense GPU BA will work, but sparse GPU BA paths remain unavailable"
    fi

    colmap_common_success "CUDA-enabled Ceres build complete"
    cd "$original_dir" || true
    return 0
}

colmap_verify_custom_ceres_integration() {
    local build_dir="$1"
    local colmap_bin="$2"
    local expected_cmake_dir="$3"
    local expected_lib_dir="$4"
    local linked_path=""

    [ -f "$build_dir/CMakeCache.txt" ] || return 1
    [ -x "$colmap_bin" ] || return 1
    [ -n "$expected_cmake_dir" ] || return 1
    [ -n "$expected_lib_dir" ] || return 1

    expected_cmake_dir=$(readlink -f "$expected_cmake_dir")
    expected_lib_dir=$(readlink -f "$expected_lib_dir")

    if ! grep -Eq "^Ceres_DIR:[^=]+=${expected_cmake_dir//\//\\/}$" "$build_dir/CMakeCache.txt"; then
        return 1
    fi

    linked_path=$(ldd "$colmap_bin" 2>/dev/null | awk '/libceres/ {print $3; exit}')
    if [ -z "$linked_path" ]; then
        # Static libceres linkage will not appear in ldd once CMake is pointed
        # at the custom package config, so treat the configured integration as OK.
        return 0
    fi

    linked_path=$(readlink -f "$linked_path")
    [[ "$linked_path" == "$expected_lib_dir/"* ]]
}
