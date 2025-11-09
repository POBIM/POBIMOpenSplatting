#!/bin/bash
# Manual sparse reconstruction with new COLMAP binary

PROJECT_ID="b726df86-6909-4699-b155-49ebbc114902"
PROJECT_DIR="/home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend/uploads/$PROJECT_ID"
COLMAP_BIN="/home/pobimgroup/POBIMOpenSplat/colmap-build/src/colmap/exe/colmap"

echo "======================================"
echo "  Sparse Reconstruction Test"
echo "======================================"
echo ""
echo "Project: $PROJECT_ID"
echo "COLMAP: $COLMAP_BIN"
echo ""

# Check COLMAP
if [ ! -f "$COLMAP_BIN" ]; then
    echo "❌ COLMAP binary not found!"
    exit 1
fi

echo "✓ COLMAP version:"
$COLMAP_BIN -h | head -3
echo ""

# Check files
if [ ! -f "$PROJECT_DIR/database.db" ]; then
    echo "❌ Database not found!"
    exit 1
fi

if [ ! -d "$PROJECT_DIR/images" ]; then
    echo "❌ Images directory not found!"
    exit 1
fi

NUM_IMAGES=$(ls -1 "$PROJECT_DIR/images" | wc -l)
echo "✓ Database: $(du -h "$PROJECT_DIR/database.db" | cut -f1)"
echo "✓ Images: $NUM_IMAGES"
echo ""

# Run mapper (WITHOUT ba_global_use_pba option)
echo "🔄 Running COLMAP mapper..."
echo ""

$COLMAP_BIN mapper \
    --database_path "$PROJECT_DIR/database.db" \
    --image_path "$PROJECT_DIR/images" \
    --output_path "$PROJECT_DIR/sparse" \
    --Mapper.min_num_matches 9 \
    --Mapper.min_model_size 8 \
    --Mapper.max_num_models 30 \
    --Mapper.init_num_trials 225 \
    --Mapper.max_extra_param 1 \
    --Mapper.num_threads 14

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Mapper completed successfully!"
    echo ""
    
    # Check output
    if [ -d "$PROJECT_DIR/sparse/0" ]; then
        echo "✓ Model created in sparse/0"
        ls -lh "$PROJECT_DIR/sparse/0"
    else
        echo "⚠️ No model found in sparse/0"
        ls -lh "$PROJECT_DIR/sparse/"
    fi
else
    echo ""
    echo "❌ Mapper failed with exit code $?"
fi
