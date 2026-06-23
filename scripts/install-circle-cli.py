#!/usr/bin/env python3
"""Install Circle CLI + compatible transitive deps (npm registry often times out)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / ".vendor"
CLI_DIR = VENDOR / "circle-cli"
CLI_TGZ = VENDOR / "circle-cli-0.0.5.tgz"
NM = CLI_DIR / "node_modules"
REGISTRY = "https://registry.npmjs.org"
CURL = ["curl", "-fsSL", "--retry", "5", "--retry-delay", "2", "--max-time", "300"]

# Versions that resolve @scure/bip32 + viem import issues on Node 22
PINNED = [
    ("@noble/hashes", "1.8.0"),
    ("@noble/curves", "1.9.7"),
    ("@scure/bip32", "1.7.0"),
]


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "butler-circle-install/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def download(url: str, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    r = subprocess.run([*CURL, url, "-o", str(tmp)], capture_output=True)
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 50:
        return False
    tmp.rename(dest)
    return True


def npm_target(pkg: str) -> Path:
    if pkg.startswith("@"):
        scope, name = pkg.split("/", 1)
        return NM / scope / name
    return NM / pkg


def install_dep(pkg: str, version: str, seen: set[str] | None = None) -> bool:
    if seen is None:
        seen = set()
    key = f"{pkg}@{version}"
    if key in seen:
        return True
    seen.add(key)

    target = npm_target(pkg)
    ver = version.lstrip("^~")
    encoded = urllib.parse.quote(pkg, safe="@/")
    try:
        meta = fetch_json(f"{REGISTRY}/{encoded}/{ver}")
    except Exception as e:
        print(f"  FAIL metadata {pkg}@{ver}: {e}")
        return False

    tarball_url = meta["dist"]["tarball"]
    safe = pkg.replace("@", "").replace("/", "-")
    tgz = VENDOR / f"{safe}-{ver}.tgz"
    if not tgz.exists():
        print(f"  download {pkg}@{ver}")
        if not download(tarball_url, tgz):
            print(f"  FAIL download {pkg}")
            return False

    tmp_extract = VENDOR / f"_extract_{safe}"
    if tmp_extract.exists():
        shutil.rmtree(tmp_extract)
    tmp_extract.mkdir()
    with tarfile.open(tgz, "r:gz") as tar:
        tar.extractall(path=tmp_extract, filter="data")
    src = tmp_extract / "package"
    if not src.exists():
        print(f"  FAIL extract {pkg}")
        shutil.rmtree(tmp_extract, ignore_errors=True)
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target)
    shutil.move(str(src), str(target))
    shutil.rmtree(tmp_extract, ignore_errors=True)
    print(f"  ok {pkg}@{ver}")

    pkg_json_path = target / "package.json"
    if pkg_json_path.exists():
        child = json.loads(pkg_json_path.read_text())
        for dep_pkg, dep_ver in {**child.get("dependencies", {}), **child.get("optionalDependencies", {})}.items():
            install_dep(dep_pkg, dep_ver, seen)

    return True


def ensure_cli_bundle() -> bool:
    if not CLI_TGZ.exists():
        print("==> Downloading @circle-fin/cli@0.0.5")
        if not download("https://registry.npmjs.org/@circle-fin/cli/-/cli-0.0.5.tgz", CLI_TGZ):
            return False
    if not (CLI_DIR / "dist" / "index.js").exists():
        print("==> Extracting Circle CLI")
        if CLI_DIR.exists():
            shutil.rmtree(CLI_DIR)
        CLI_DIR.mkdir(parents=True)
        with tarfile.open(CLI_TGZ, "r:gz") as tar:
            tar.extractall(path=CLI_DIR, filter="data")
            pkg = CLI_DIR / "package"
            if pkg.exists():
                for item in pkg.iterdir():
                    dest = CLI_DIR / item.name
                    if dest.exists():
                        if dest.is_dir():
                            shutil.rmtree(dest)
                        else:
                            dest.unlink()
                    shutil.move(str(item), str(dest))
                pkg.rmdir()
    return (CLI_DIR / "dist" / "index.js").exists()


def main() -> int:
    print("==> Butler Circle CLI installer")
    if not ensure_cli_bundle():
        print("FAIL: could not install Circle CLI bundle", file=sys.stderr)
        return 1

    pkg_json = json.loads((CLI_DIR / "package.json").read_text())
    deps: dict[str, str] = {}
    deps.update(pkg_json.get("dependencies", {}))
    deps.update(pkg_json.get("optionalDependencies", {}))

    seen: set[str] = set()
    for pkg, version in sorted(deps.items()):
        install_dep(pkg, version, seen)

    print("==> Pinning compatible @noble / @scure versions")
    for pkg, version in PINNED:
        install_dep(pkg, version, seen)

    print(f"==> Installed {len(seen)} packages (including transitive)")

    env = {
        **os.environ,
        "NODE_PATH": str(NM),
        "CIRCLE_ACCEPT_TERMS": "1",
    }
    r = subprocess.run(
        ["node", str(CLI_DIR / "dist" / "index.js"), "--version"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    if r.returncode == 0:
        print(f"==> Circle CLI ready: {(r.stdout or r.stderr).strip()}")
        return 0

    print("==> Circle CLI binary failed:", r.stderr or r.stdout, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
