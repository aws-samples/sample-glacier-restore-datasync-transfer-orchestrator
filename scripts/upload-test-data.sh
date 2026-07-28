#!/bin/bash
# Upload sample test files to the source bucket across different Glacier storage classes.
#
# Usage:
#   ./scripts/upload-test-data.sh <bucket> [options]
#
# Options:
#   -n, --num-files <count>    Number of files to generate per storage class (default: 3)
#   -d, --depth <levels>       Nesting depth of folder hierarchy (default: 2)
#   -s, --size <mb>            Size of each file in MB (default: 1)
#   --flat                     No nested folders — all files at the top level
#   --classes <list>           Comma-separated storage classes to use
#                              (default: GLACIER,GLACIER_IR,DEEP_ARCHIVE,INTELLIGENT_TIERING)
#   -h, --help                 Show this help message
#
# Examples:
#   # Default: 3 files per class, 2 levels deep
#   ./scripts/upload-test-data.sh my-bucket
#
#   # 10 files per class, 4 levels deep (good for glob testing)
#   ./scripts/upload-test-data.sh my-bucket -n 10 -d 4
#
#   # Flat structure, 5 files, only GLACIER
#   ./scripts/upload-test-data.sh my-bucket -n 5 --flat --classes GLACIER
#
#   # Large batch for threshold testing (>50 total files)
#   ./scripts/upload-test-data.sh my-bucket -n 15 -d 3

set -euo pipefail

# ─── Defaults ───────────────────────────────────────────────────────────────
NUM_FILES=3
DEPTH=2
FILE_SIZE_MB=1
FLAT=false
STORAGE_CLASSES="GLACIER,GLACIER_IR,DEEP_ARCHIVE,INTELLIGENT_TIERING"

# ─── Parse arguments ────────────────────────────────────────────────────────
BUCKET=""

show_help() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) show_help ;;
    -n|--num-files) NUM_FILES="$2"; shift 2 ;;
    -d|--depth) DEPTH="$2"; shift 2 ;;
    -s|--size) FILE_SIZE_MB="$2"; shift 2 ;;
    --flat) FLAT=true; shift ;;
    --classes) STORAGE_CLASSES="$2"; shift 2 ;;
    -*)
      echo "Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
    *)
      if [ -z "$BUCKET" ]; then
        BUCKET="$1"
      else
        echo "Unexpected argument: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$BUCKET" ]; then
  echo "Usage: $0 <source-bucket-name> [options]"
  echo ""
  echo "Get the bucket name from the testing stack output:"
  echo "  aws cloudformation describe-stacks --stack-name RestoreTransferTestingStack \\"
  echo "    --query \"Stacks[0].Outputs[?OutputKey=='SourceBucketNameOutput'].OutputValue\" --output text"
  echo ""
  echo "Run with --help for full options."
  exit 1
fi

# Split classes into array
IFS=',' read -ra CLASSES <<< "$STORAGE_CLASSES"

# ─── File extensions by category (rotated through for variety) ──────────────
EXTENSIONS=("exr" "tif" "dpx" "mov" "vdb" "abc" "bgeo" "hdr" "png" "jpg")

# ─── Folder name pools for generating nested paths ─────────────────────────
PROJECTS=("alpha" "beta" "gamma" "delta" "epsilon")
CATEGORIES=("renders" "assets" "shots" "editorial" "cache" "plates" "comps" "lookdev" "fx" "lighting")
SUBCATEGORIES=("v01" "v02" "final" "wip" "review" "approved" "daily" "weekly")
DEEP_FOLDERS=("pass_beauty" "pass_diffuse" "pass_specular" "pass_depth" "left_eye" "right_eye" "stereo" "mono")

# ─── Temp directory ─────────────────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ─── Path generation ────────────────────────────────────────────────────────
generate_path() {
  local index="$1"

  if [ "$FLAT" = true ]; then
    local ext="${EXTENSIONS[$((index % ${#EXTENSIONS[@]}))]}"
    echo "file_$(printf '%03d' "$index").$ext"
    return
  fi

  local project="${PROJECTS[$((index % ${#PROJECTS[@]}))]}"
  local category="${CATEGORIES[$(( (index / ${#PROJECTS[@]}) % ${#CATEGORIES[@]} ))]}"
  local ext="${EXTENSIONS[$((index % ${#EXTENSIONS[@]}))]}"
  local filename="$(printf '%s_%03d.%s' "$category" "$index" "$ext")"

  local path="project-${project}/${category}"

  if [ "$DEPTH" -ge 3 ]; then
    local sub="${SUBCATEGORIES[$(( (index * 7) % ${#SUBCATEGORIES[@]} ))]}"
    path="${path}/${sub}"
  fi

  if [ "$DEPTH" -ge 4 ]; then
    local deep="${DEEP_FOLDERS[$(( (index * 3) % ${#DEEP_FOLDERS[@]} ))]}"
    path="${path}/${deep}"
  fi

  echo "${path}/${filename}"
}

# ─── Generate and upload ────────────────────────────────────────────────────
TOTAL_FILES=$(( NUM_FILES * ${#CLASSES[@]} ))

echo "=== Upload Test Data Configuration ==="
echo "  Bucket:          s3://$BUCKET"
echo "  Files per class: $NUM_FILES"
echo "  Storage classes: ${CLASSES[*]}"
echo "  Folder depth:    $([ "$FLAT" = true ] && echo "flat (no nesting)" || echo "$DEPTH levels")"
echo "  File size:       ${FILE_SIZE_MB} MB each"
echo "  Total files:     $TOTAL_FILES"
echo "  Total size:      ~$(( TOTAL_FILES * FILE_SIZE_MB )) MB"
echo ""

file_index=0

for class in "${CLASSES[@]}"; do
  echo "--- ${class} (${NUM_FILES} files) ---"

  for i in $(seq 1 "$NUM_FILES"); do
    filepath=$(generate_path "$file_index")

    # Generate file
    mkdir -p "$TMPDIR/$(dirname "$filepath")"
    dd if=/dev/urandom of="$TMPDIR/$filepath" bs=1048576 count="$FILE_SIZE_MB" 2>/dev/null

    # Upload
    aws s3 cp "$TMPDIR/$filepath" "s3://$BUCKET/$filepath" --storage-class "$class" --quiet
    echo "  [$((file_index + 1))/$TOTAL_FILES] $filepath → $class"

    file_index=$((file_index + 1))
  done
  echo ""
done

echo "=== Done ==="
echo ""
echo "Summary:"
for class in "${CLASSES[@]}"; do
  echo "  $NUM_FILES files → $class"
done
echo "  ─────────────────"
echo "  $TOTAL_FILES files total"
echo ""

if [ "$FLAT" = false ] && [ "$DEPTH" -ge 2 ]; then
  echo "Glob patterns to test:"
  echo "  project-alpha/**/*.exr    (recursive wildcard)"
  echo "  project-*/renders/*       (single-level wildcard)"
  echo "  **/v01/**                 (deep nested match)"
  echo "  project-beta/shots/*.dpx  (specific folder + extension)"
  echo ""
fi

echo "Verify with:"
echo "  aws s3api list-objects-v2 --bucket $BUCKET --query 'Contents[*].[Key,StorageClass,Size]' --output table"
