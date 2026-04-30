"""Runtime and COLMAP capability helpers for the pipeline runner."""

from __future__ import annotations

import importlib
import logging
import os
import re
import sqlite3
import subprocess
from functools import lru_cache
from pathlib import Path

from ..core import config as app_config

logger = logging.getLogger(__name__)


def get_glomap_executable():
    """Resolve a GLOMAP binary that is compatible with the active COLMAP build."""
    for candidate in app_config.GLOMAP_CANDIDATE_PATHS:
        try:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        except OSError:
            continue

    try:
        result = subprocess.run(['which', 'glomap'], capture_output=True, text=True)
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass

    return None


GLOMAP_PATH = get_glomap_executable()


def get_fastmap_executable():
    if hasattr(app_config, 'FASTMAP_PATH') and app_config.FASTMAP_PATH:
        return app_config.FASTMAP_PATH
    return None


FASTMAP_PATH = get_fastmap_executable()


def check_hloc_available():
    """Check if hloc is available for neural feature extraction."""
    if hasattr(app_config, 'HLOC_INSTALLED') and app_config.HLOC_INSTALLED:
        return True
    try:
        import hloc  # noqa: F401
        from lightglue import ALIKED, LightGlue  # noqa: F401
        return True
    except ImportError:
        return False


HLOC_AVAILABLE = check_hloc_available()


def normalize_feature_method(feature_method):
    if feature_method is None:
        return 'sift'

    normalized = str(feature_method).strip().lower()
    if normalized in {'sift', 'aliked', 'superpoint'}:
        return normalized

    return 'sift'


def normalize_matcher_type(matcher_type):
    if matcher_type is None:
        return None

    normalized = str(matcher_type).strip().lower()
    if normalized in {"sequential", "exhaustive", "vocab_tree"}:
        return normalized
    if normalized in {"tree", "vocabulary_tree", "vocabulary-tree"}:
        return "vocab_tree"

    return None


def normalize_sfm_engine(sfm_engine):
    if sfm_engine is None:
        return 'glomap'

    normalized = str(sfm_engine).strip().lower()
    if normalized in {'glomap', 'global', 'global_mapper'}:
        return 'glomap'
    if normalized in {'colmap', 'incremental'}:
        return 'colmap'
    if normalized == 'fastmap':
        return 'fastmap'
    return 'glomap'


def normalize_sfm_backend(sfm_backend):
    if sfm_backend is None:
        return 'cli'

    normalized = str(sfm_backend).strip().lower()
    if normalized in {'cli', 'command', 'subprocess'}:
        return 'cli'
    if normalized in {'pycolmap', 'python'}:
        return 'pycolmap'
    return 'cli'


@lru_cache(maxsize=1)
def get_pycolmap_module():
    try:
        return importlib.import_module('pycolmap')
    except Exception:
        return None


def pycolmap_supports_global_mapping():
    pycolmap = get_pycolmap_module()
    return bool(
        pycolmap
        and hasattr(pycolmap, 'global_mapping')
        and hasattr(pycolmap, 'GlobalMapperOptions')
        and hasattr(pycolmap, 'BundleAdjustmentOptions')
    )


@lru_cache(maxsize=4)
def colmap_supports_global_mapper(colmap_exe):
    try:
        result = subprocess.run(
            [colmap_exe, 'global_mapper', '-h'],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return False

    output = f"{result.stdout}\n{result.stderr}".lower()
    return result.returncode == 0 or 'global_mapper' in output


@lru_cache(maxsize=4)
def get_colmap_feature_extraction_max_image_size_flag(colmap_exe):
    try:
        result = subprocess.run(
            [colmap_exe, 'feature_extractor', '-h'],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return '--FeatureExtraction.max_image_size'

    output = f"{result.stdout}\n{result.stderr}"
    if 'FeatureExtraction.max_image_size' in output:
        return '--FeatureExtraction.max_image_size'
    if 'SiftExtraction.max_image_size' in output:
        return '--SiftExtraction.max_image_size'

    return '--FeatureExtraction.max_image_size'


@lru_cache(maxsize=4)
def get_colmap_native_feature_capabilities(colmap_exe):
    def _run_help(command):
        try:
            result = subprocess.run(
                [colmap_exe, command, '-h'],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except Exception:
            return ''

        return f"{result.stdout}\n{result.stderr}"

    extraction_output = _run_help('feature_extractor')
    matching_output = _run_help('exhaustive_matcher')
    extraction_lower = extraction_output.lower()
    matching_lower = matching_output.lower()

    return {
        'supports_feature_extraction_type': 'featureextraction.type' in extraction_lower,
        'supports_aliked_extraction': 'alikedextraction.max_num_features' in extraction_lower,
        'supports_feature_matching_type': 'featurematching.type' in matching_lower,
        'supports_aliked_bruteforce': (
            'alikedmatching.bruteforce_model_path' in matching_lower
            or 'alikedmatching.brute_force_min_cossim' in matching_lower
        ),
        'supports_aliked_lightglue': 'alikedmatching.lightglue_model_path' in matching_lower,
    }


def _find_colmap_build_dir(colmap_exe):
    try:
        exe_path = Path(colmap_exe).resolve()
    except Exception:
        return None

    candidates = []
    if exe_path.name == 'colmap':
        candidates.extend(
            [
                exe_path.parents[2] if len(exe_path.parents) > 2 else None,
                exe_path.parents[3] if len(exe_path.parents) > 3 else None,
            ]
        )

    for candidate in candidates:
        if candidate and (candidate / 'CMakeCache.txt').is_file():
            return candidate

    return None


@lru_cache(maxsize=4)
def get_colmap_ceres_capabilities(colmap_exe):
    build_dir = _find_colmap_build_dir(colmap_exe)
    result = {
        'build_dir': str(build_dir) if build_dir else None,
        'ceres_dir': None,
        'ceres_version': None,
        'ceres_cuda_enabled': False,
        'ceres_cudss_enabled': False,
    }

    if not build_dir:
        return result

    cache_path = build_dir / 'CMakeCache.txt'
    try:
        cache_text = cache_path.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return result

    ceres_dir_match = re.search(r'^Ceres_DIR:[^=]+=(.+)$', cache_text, re.MULTILINE)
    if not ceres_dir_match:
        return result

    ceres_dir = Path(ceres_dir_match.group(1).strip()).resolve()
    result['ceres_dir'] = str(ceres_dir)

    version_header = ceres_dir.parents[2] / 'include' / 'ceres' / 'version.h'
    if version_header.is_file():
        try:
            version_text = version_header.read_text(encoding='utf-8', errors='ignore')
            major_match = re.search(r'^#define CERES_VERSION_MAJOR (\d+)$', version_text, re.MULTILINE)
            minor_match = re.search(r'^#define CERES_VERSION_MINOR (\d+)$', version_text, re.MULTILINE)
            patch_match = re.search(r'^#define CERES_VERSION_REVISION (\d+)$', version_text, re.MULTILINE)
            if major_match and minor_match and patch_match:
                result['ceres_version'] = '.'.join(
                    [major_match.group(1), minor_match.group(1), patch_match.group(1)]
                )
        except Exception:
            pass

    targets_text = ""
    for candidate in ('CeresTargets.cmake', 'CeresTargets-release.cmake', 'CeresConfig.cmake'):
        target_path = ceres_dir / candidate
        if target_path.is_file():
            try:
                targets_text += "\n" + target_path.read_text(encoding='utf-8', errors='ignore')
            except Exception:
                pass

    if 'ceres_cuda_kernels' in targets_text or 'find_dependency(CUDAToolkit' in targets_text:
        result['ceres_cuda_enabled'] = True

    config_header = ceres_dir.parents[2] / 'include' / 'ceres' / 'internal' / 'config.h'
    if config_header.is_file():
        try:
            config_text = config_header.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            config_text = ''
        if 'CERES_NO_CUDSS' in config_text and not re.search(
            r'^\s*#define\s+CERES_NO_CUDSS\b', config_text, re.MULTILINE
        ):
            result['ceres_cudss_enabled'] = True

    ceres_build_dir = None
    try:
        if ceres_dir.parts[-4:] == ('install', 'lib', 'cmake', 'Ceres'):
            ceres_build_dir = ceres_dir.parents[3]
    except Exception:
        ceres_build_dir = None

    if ceres_build_dir and (ceres_build_dir / 'CMakeCache.txt').is_file():
        try:
            ceres_cache_text = (ceres_build_dir / 'CMakeCache.txt').read_text(encoding='utf-8', errors='ignore')
        except Exception:
            ceres_cache_text = ''
        if re.search(r'(^|[^A-Z])CUDSS([^A-Z]|$)', ceres_cache_text):
            result['ceres_cudss_enabled'] = True

    if not result['ceres_cudss_enabled']:
        try:
            ldconfig_output = subprocess.run(
                ['bash', '-lc', 'ldconfig -p | grep -i cudss || true'],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if ldconfig_output.stdout.strip():
                # Runtime library availability alone does not guarantee compile-time
                # support, but when present it is still useful for diagnostics.
                result['ceres_cudss_enabled'] = 'CUDSS' in targets_text or 'cudss' in targets_text.lower()
        except Exception:
            pass

    return result


def describe_colmap_bundle_adjustment_mode(colmap_exe, num_images, has_cuda):
    caps = get_colmap_ceres_capabilities(colmap_exe)
    plan = {
        'mode': 'cpu',
        'summary': 'CPU bundle adjustment only',
        'runtime_summary': 'CPU bundle adjustment fallback',
        'detail': 'COLMAP mapper registration remains CPU-heavy.',
        'caps': caps,
    }

    if not has_cuda:
        plan['detail'] = 'COLMAP was started without CUDA support.'
        return plan

    if not caps['ceres_cuda_enabled']:
        plan['detail'] = 'Ceres lacks CUDA dense solver support.'
        return plan

    if num_images < 50:
        plan['detail'] = 'Problem is below COLMAP GPU BA threshold (min_num_images_gpu_solver=50).'
        return plan

    if num_images <= 200:
        plan['mode'] = 'gpu_dense'
        plan['summary'] = 'GPU bundle adjustment via DENSE_SCHUR'
        plan['runtime_summary'] = 'GPU dense BA (DENSE_SCHUR)'
        plan['detail'] = (
            f'{num_images} images is within COLMAP direct dense GPU threshold '
            '(<= 200). Registration between BA passes still runs mostly on CPU.'
        )
        return plan

    if caps['ceres_cudss_enabled'] and num_images <= 4000:
        plan['mode'] = 'gpu_sparse'
        plan['summary'] = 'GPU bundle adjustment via SPARSE_SCHUR + cuDSS'
        plan['runtime_summary'] = 'GPU sparse BA via cuDSS (SPARSE_SCHUR)'
        plan['detail'] = (
            f'{num_images} images exceeds dense GPU threshold, but cuDSS support '
            'is available for sparse GPU BA.'
        )
        return plan

    plan['detail'] = (
        f'{num_images} images exceeds dense GPU threshold (200) and this build '
        'does not expose cuDSS sparse GPU BA, so solver work is expected to stay mostly on CPU.'
    )
    return plan


def get_native_aliked_max_num_features(quality_mode, fallback_max_num_features):
    caps = {
        'fast': 2048,
        'balanced': 4096,
        'high': 4096,
        'ultra': 6144,
        'hard': 8192,
        'fog_heavy': 8192,
        'production_balanced': 8192,
        'professional': 8192,
        'ultra_professional': 12288,
        'robust': 8192,
        'custom': 4096,
    }
    default_cap = caps.get(str(quality_mode or 'balanced').strip().lower(), 4096)
    return min(int(fallback_max_num_features), default_cap)


def resolve_colmap_feature_pipeline_profile(config, colmap_cfg, colmap_exe):
    feature_method = normalize_feature_method(config.get('feature_method', 'sift'))
    capabilities = get_colmap_native_feature_capabilities(colmap_exe)

    profile = {
        'feature_method': feature_method,
        'extractor_type': 'SIFT',
        'matcher_type': 'SIFT_BRUTEFORCE',
        'is_native_neural': False,
        'uses_lightglue': False,
        'extractor_args': [],
        'matcher_args': [],
        'description': 'classic SIFT + brute-force matching',
    }

    if feature_method != 'aliked':
        return profile

    if not (
        capabilities['supports_feature_extraction_type']
        and capabilities['supports_aliked_extraction']
        and capabilities['supports_feature_matching_type']
    ):
        return profile

    fallback_max_num_features = int(colmap_cfg.get('max_num_features', 4096))
    max_num_features = get_native_aliked_max_num_features(
        config.get('quality_mode'),
        fallback_max_num_features,
    )

    matcher_type = 'ALIKED_BRUTEFORCE'
    if capabilities['supports_aliked_lightglue']:
        matcher_type = 'ALIKED_LIGHTGLUE'
    elif not capabilities['supports_aliked_bruteforce']:
        return profile

    profile.update(
        {
            'extractor_type': 'ALIKED_N16ROT',
            'matcher_type': matcher_type,
            'is_native_neural': True,
            'uses_lightglue': matcher_type == 'ALIKED_LIGHTGLUE',
            'extractor_args': [
                '--FeatureExtraction.type',
                'ALIKED_N16ROT',
                '--AlikedExtraction.max_num_features',
                str(max_num_features),
            ],
            'matcher_args': ['--FeatureMatching.type', matcher_type],
            'description': (
                'native ALIKED + LightGlue'
                if matcher_type == 'ALIKED_LIGHTGLUE'
                else 'native ALIKED + brute-force matching'
            ),
        }
    )

    return profile


@lru_cache(maxsize=1)
def get_gpu_total_vram_mb():
    try:
        result = subprocess.run(
            [
                'nvidia-smi',
                '--query-gpu=memory.total',
                '--format=csv,noheader,nounits',
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None

        values = [int(line.strip()) for line in result.stdout.splitlines() if line.strip()]
        if not values:
            return None

        return max(values)
    except Exception:
        return None


def get_peak_feature_count(database_path):
    if not Path(database_path).exists():
        return None

    try:
        with sqlite3.connect(str(database_path)) as conn:
            row = conn.execute('SELECT MAX(rows) FROM keypoints').fetchone()
    except sqlite3.Error:
        return None

    if not row or row[0] is None:
        return None

    try:
        return int(row[0])
    except (TypeError, ValueError):
        return None


def count_verified_matching_pairs(database_path):
    if not Path(database_path).exists():
        return 0

    try:
        with sqlite3.connect(str(database_path)) as conn:
            row = conn.execute('SELECT COUNT(*) FROM two_view_geometries').fetchone()
    except sqlite3.Error:
        return 0

    return int(row[0] or 0) if row else 0


def is_gpu_matching_error_text(text):
    lowered = str(text or '').lower()
    if not lowered:
        return False

    error_patterns = (
        'insufficient cuda memory',
        'out of memory',
        'cuda error',
        'cuda memory',
        'cuda out of memory',
        'gpu memory',
        'illegal memory access',
        'cublas',
        'failed to load shared library',
        'onnx runtime error',
        'libcudnn.so',
    )
    return any(pattern in lowered for pattern in error_patterns)


def should_log_subprocess_line(line):
    text = str(line or '').strip()
    if not text:
        return False

    lowered = text.lower()
    important_prefixes = (
        'e',
        'w',
        'f',
    )
    important_tokens = (
        'error',
        'warning',
        'warn',
        'failed',
        'exception',
        'traceback',
        'terminate called',
        'aborted at',
        'what():',
        'cuda',
        'cudnn',
        'onnx',
        'illegal memory access',
    )

    return lowered.startswith(important_prefixes) or any(token in lowered for token in important_tokens)


def should_emit_progress_milestone(progress_state, current, total, *, percent_step=10):
    if total <= 0 or current <= 0:
        return False, None

    percent = int((current / total) * 100)
    progress_bucket = min(100, (percent // percent_step) * percent_step)
    if progress_bucket <= progress_state.get('last_bucket', -1):
        return False, progress_bucket

    progress_state['last_bucket'] = progress_bucket
    return True, progress_bucket


def estimate_gpu_safe_match_limit(total_vram_mb=None, peak_feature_count=None):
    limits = []

    if total_vram_mb:
        vram_scaled_limit = int((max(total_vram_mb, 1024) / 1024.0) * 4096)
        vram_scaled_limit = max(16384, min(65536, (vram_scaled_limit // 1024) * 1024))
        limits.append(vram_scaled_limit)

    if peak_feature_count:
        feature_scaled_limit = int(peak_feature_count * 0.5)
        feature_scaled_limit = max(16384, min(65536, (feature_scaled_limit // 1024) * 1024))
        limits.append(feature_scaled_limit)

    if not limits:
        return None

    return min(limits)


def get_cpu_retry_match_limit(max_num_matches):
    return max(8192, min(int(max_num_matches) // 2, 32768))


def get_gpu_retry_match_limits(max_num_matches, peak_feature_count=None):
    base_limit = max(8192, int(max_num_matches))
    candidates = []
    seen = {base_limit}

    halved_limit = base_limit
    while halved_limit > 8192:
        halved_limit = max(8192, (halved_limit // 2 // 1024) * 1024)
        if halved_limit not in seen:
            candidates.append(halved_limit)
            seen.add(halved_limit)

    if peak_feature_count:
        feature_scaled_limit = int(peak_feature_count * 0.25)
        feature_scaled_limit = max(8192, min(base_limit, (feature_scaled_limit // 1024) * 1024))
        if feature_scaled_limit not in seen:
            candidates.insert(0, feature_scaled_limit)

    return [limit for limit in candidates if limit < base_limit]


def get_vocab_tree_matcher_params():
    matcher_params = {}
    vocab_tree_path = getattr(app_config, 'VOCAB_TREE_PATH', None)
    if vocab_tree_path and Path(vocab_tree_path).exists():
        matcher_params['VocabTreeMatching.vocab_tree_path'] = str(vocab_tree_path)
    return matcher_params


def resolve_global_sfm_backend(colmap_exe):
    global_command = getattr(app_config, 'COLMAP_GLOBAL_MAPPER_COMMAND', None)
    if colmap_supports_global_mapper(colmap_exe):
        return {
            'mode': 'colmap_global',
            'command': list(global_command) if global_command else [colmap_exe, 'global_mapper'],
            'label': 'COLMAP Global Mapper',
            'subtext': 'COLMAP global SfM',
        }

    legacy_glomap_command = getattr(app_config, 'GLOMAP_COMMAND', None)
    if GLOMAP_PATH is not None:
        return {
            'mode': 'legacy_glomap',
            'command': list(legacy_glomap_command) if legacy_glomap_command else [GLOMAP_PATH, 'mapper'],
            'label': 'Legacy GLOMAP',
            'subtext': 'Legacy standalone glomap',
        }

    return None
