#!/usr/bin/env bash
# Creates a small sample repository plus ZIP variants used to exercise the
# RepoLens Phase 1 ingestion flow. Artifacts land in data/_test/ (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="data/_test"
rm -rf "$OUT"
mkdir -p "$OUT"
REPO="$OUT/sample-repo"
mkdir -p "$REPO/src" "$REPO/docs"

cd "$REPO"
git init -q -b main

git config user.name "Alice Dev"
git config user.email "alice@example.com"
printf '# Sample Repo\n\nDemo repository for RepoLens ingestion tests.\n' > README.md
printf 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n' > src/app.js
git add -A
git commit -qm "Initial commit: add README and greet helper"

git config user.name "Bob Coder"
git config user.email "bob@example.com"
printf 'export const VERSION = "1.0.0";\n' > src/util.js
printf '# Notes\n\n- item one\n- item two\n' > docs/notes.md
git add -A
git commit -qm "Add util module and project notes"

git config user.name "Alice Dev"
git config user.email "alice@example.com"
printf 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nexport function bye(name) {\n  return `Bye, ${name}.`;\n}\n' > src/app.js
git add -A
git commit -qm "Add farewell helper to app"

git config user.name "Bob Coder"
git config user.email "bob@example.com"
printf 'export const VERSION = "1.0.1";\nimport { greet } from "./app.js";\n\nconsole.log(greet("world"));\n' > src/util.js
git add -A
git commit -qm "Bump version and wire greet import"

git config user.name "Bob Coder"
git config user.email "bob@example.com"
printf '# Release Notes\n\n- v1.0.1 fixes the greeting import.\n' > "docs/release notes.md"
printf '# Ueber Notes\n' > "docs/über.md"
python3 -c "open('docs/logo.png','wb').write(bytes([137,80,78,71,0,1,2,3,255]))"
git add -A
git commit -qm "Add release notes, ueber doc and binary logo"

git config user.name "Alice Dev"
git config user.email "alice@example.com"
printf '# Sample Repo\n\nDemo repository for RepoLens ingestion tests.\n\n## Usage\n\nRun `node src/util.js`.\n' > README.md
git add -A
git commit -qm "Document usage in README"

cd "$ROOT"

python3 - "$OUT" <<'PY'
import os
import sys
import zipfile

out = sys.argv[1]
repo = os.path.join(out, "sample-repo")


def zip_tree(src, dest, prefix=""):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(src):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, src)
                arc = os.path.join(prefix, rel) if prefix else rel
                zf.write(full, arc)


# Zip containing the repository folder itself.
zip_tree(repo, os.path.join(out, "sample-repo.zip"), prefix="sample-repo")
# Zip containing the repository contents (.git at archive root).
zip_tree(repo, os.path.join(out, "sample-flat.zip"))
# Archive without any git directory (expected to be rejected by ingestion).
with zipfile.ZipFile(os.path.join(out, "not-a-repo.zip"), "w") as zf:
    zf.writestr("README.md", "This archive has no git history.\n")
print("fixtures written to", out)
PY

echo "fixtures ready in $OUT"
