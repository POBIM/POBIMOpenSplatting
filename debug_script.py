import json
import os
import sys
from types import SimpleNamespace

# Add the project root to sys.path to ensure imports work
sys.path.append(os.getcwd())

try:
    from PobimSplatting.Backend.pipeline.runner import get_colmap_config_for_pipeline, report_sparse_model_coverage
    from PobimSplatting.Backend.pipeline.recovery_planners import _is_matcher_fallback_retry_candidate
except ImportError as e:
    print(f"ImportError: {e}")
    sys.exit(1)

project_id = "58c90afe-70d5-4c58-8149-53faa018172e"
db_path = "PobimSplatting/Backend/projects_db.json"

with open(db_path, 'r') as f:
    db = json.load(f)

project_data = db.get(project_id)
if not project_data:
    print(f"Project {project_id} not found in DB")
    sys.exit(1)

# Paths as dict
upload_dir = os.path.join(os.getcwd(), "PobimSplatting/Backend/uploads", project_id)
paths = {
    "upload_dir": upload_dir,
    "images_path": os.path.join(upload_dir, "images"),
    "sparse_path": os.path.join(upload_dir, "sparse"),
    "database_path": os.path.join(upload_dir, "database.db")
}

# Config as dict
config = project_data['config']

try:
    num_images, colmap_cfg = get_colmap_config_for_pipeline(paths, config, project_id)
    sparse_summary = report_sparse_model_coverage(project_id, paths, config, colmap_cfg, num_images)
    
    # Check if _is_matcher_fallback_retry_candidate expects config as dict or Namespace
    # Usually it's Namespace in business logic, but let's try dict first and then wrap if it fails
    config_ns = SimpleNamespace(**config)
    # Check if colmap_cfg needs to be Namespace
    colmap_cfg_ns = SimpleNamespace(**colmap_cfg) if isinstance(colmap_cfg, dict) else colmap_cfg
    
    candidate = _is_matcher_fallback_retry_candidate(config_ns, colmap_cfg_ns, sparse_summary, num_images)

    result = {
        "config_matcher_type": config.get('matcher_type'),
        "config_matcher_fallback_retry_type": config.get('matcher_fallback_retry_type'),
        "colmap_cfg_matcher_type": getattr(colmap_cfg_ns, 'matcher_type', None),
        "sparse_summary": sparse_summary,
        "is_candidate": candidate
    }
    print(json.dumps(result, indent=2))
except Exception as e:
    print(f"Error during execution: {e}")
    import traceback
    traceback.print_exc()
