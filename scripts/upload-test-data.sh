#!/bin/bash
# Upload sample test files to the source bucket across different Glacier storage classes.
# Usage: ./scripts/upload-test-data.sh <source-bucket-name>
#
# This creates small test files (1-5 MB) and uploads them directly to various
# Glacier tiers using the --storage-class flag.

set -euo pipefail

BUCKET="${1:-}"

if [ -z "$BUCKET" ]; then
  echo "Usage: $0 <source-bucket-name>"
  echo ""
  echo "Get the bucket name from the testing stack output:"
  echo "  aws cloudformation describe-stacks --stack-name IlmDatasyncTestingStack \\"
  echo "    --query \"Stacks[0].Outputs[?OutputKey=='SourceBucketNameOutput'].OutputValue\" --output text"
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== Generating test files ==="

# Generate random files of various sizes
generate_file() {
  local name="$1"
  local size_mb="$2"
  mkdir -p "$TMPDIR/$(dirname "$name")"
  dd if=/dev/urandom of="$TMPDIR/$name" bs=1048576 count="$size_mb" 2>/dev/null
  echo "  Created $name (${size_mb} MB)"
}

# Create test files
generate_file "project-alpha/renders/frame_001.exr" 2
generate_file "project-alpha/renders/frame_002.exr" 3
generate_file "project-alpha/renders/frame_003.exr" 2
generate_file "project-alpha/assets/texture_diffuse.tif" 5
generate_file "project-alpha/assets/texture_normal.tif" 4
generate_file "project-beta/shots/shot_010_comp.dpx" 3
generate_file "project-beta/shots/shot_020_comp.dpx" 3
generate_file "project-beta/editorial/edit_v01.mov" 5
generate_file "project-gamma/plates/plate_bg_001.exr" 4
generate_file "project-gamma/plates/plate_bg_002.exr" 4
generate_file "project-gamma/cache/sim_fluid_001.vdb" 2
generate_file "project-gamma/cache/sim_fluid_002.vdb" 1

echo ""
echo "=== Uploading to s3://$BUCKET ==="
echo ""

# Upload to GLACIER storage class
echo "--- GLACIER ---"
for f in project-alpha/renders/frame_001.exr \
         project-alpha/renders/frame_002.exr \
         project-alpha/renders/frame_003.exr \
         project-alpha/assets/texture_diffuse.tif; do
  aws s3 cp "$TMPDIR/$f" "s3://$BUCKET/$f" --storage-class GLACIER --quiet
  echo "  Uploaded $f → GLACIER"
done

# Upload to GLACIER_IR (Glacier Instant Retrieval)
echo ""
echo "--- GLACIER_IR (Instant Retrieval) ---"
for f in project-alpha/assets/texture_normal.tif \
         project-beta/shots/shot_010_comp.dpx \
         project-beta/shots/shot_020_comp.dpx; do
  aws s3 cp "$TMPDIR/$f" "s3://$BUCKET/$f" --storage-class GLACIER_IR --quiet
  echo "  Uploaded $f → GLACIER_IR"
done

# Upload to DEEP_ARCHIVE
echo ""
echo "--- DEEP_ARCHIVE ---"
for f in project-beta/editorial/edit_v01.mov \
         project-gamma/plates/plate_bg_001.exr \
         project-gamma/plates/plate_bg_002.exr; do
  aws s3 cp "$TMPDIR/$f" "s3://$BUCKET/$f" --storage-class DEEP_ARCHIVE --quiet
  echo "  Uploaded $f → DEEP_ARCHIVE"
done

# Upload to INTELLIGENT_TIERING (will auto-tier, useful for edge case testing)
echo ""
echo "--- INTELLIGENT_TIERING (may archive to Glacier tiers over time) ---"
for f in project-gamma/cache/sim_fluid_001.vdb \
         project-gamma/cache/sim_fluid_002.vdb; do
  aws s3 cp "$TMPDIR/$f" "s3://$BUCKET/$f" --storage-class INTELLIGENT_TIERING --quiet
  echo "  Uploaded $f → INTELLIGENT_TIERING"
done

echo ""
echo "=== Done ==="
echo ""
echo "Summary:"
echo "  4 files → GLACIER (Standard retrieval: 3-5 hrs, Expedited: 1-5 min)"
echo "  3 files → GLACIER_IR (Instant retrieval: milliseconds)"
echo "  3 files → DEEP_ARCHIVE (Standard: 12 hrs, Bulk: 48 hrs)"
echo "  2 files → INTELLIGENT_TIERING (may auto-archive)"
echo ""
echo "Verify with:"
echo "  aws s3api list-objects-v2 --bucket $BUCKET --query 'Contents[*].[Key,StorageClass,Size]' --output table"
