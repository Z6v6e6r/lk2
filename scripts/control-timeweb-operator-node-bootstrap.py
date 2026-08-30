#!/usr/bin/python3
"""Fail-closed Timeweb operator Node bootstrap controller.

Live modes deliberately require the fixed system Python launcher and a frozen, root-owned
release checkout.  The controller never accepts package names, versions, repositories or state
paths from argv; those values come only from the protected contract in the same Git tree.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


SCHEMA = "PHUB_TIMEWEB_OPERATOR_NODE_BOOTSTRAP_V1"
PLAN_SCHEMA = "PHUB_TIMEWEB_OPERATOR_NODE_BOOTSTRAP_PLAN_V1"
TRANSACTION_SCHEMA = "PHUB_TIMEWEB_OPERATOR_NODE_BOOTSTRAP_TRANSACTION_V1"
RECEIPT_SCHEMA = "PHUB_TIMEWEB_OPERATOR_NODE_BOOTSTRAP_RECEIPT_V1"
ROLLBACK_SCHEMA = "PHUB_TIMEWEB_OPERATOR_NODE_BOOTSTRAP_ROLLBACK_V2"
FAILED_APPLY_ROLLBACK_SCHEMA = "PHUB_TIMEWEB_OPERATOR_NODE_BOOTSTRAP_FAILED_APPLY_ROLLBACK_V1"
REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPOSITORY_ROOT / "deploy/timeweb/operator-node-bootstrap.v1.json"
PROTECTED_PATHS = (
    "scripts/control-timeweb-operator-node-bootstrap.py",
    "scripts/verify-timeweb-frozen-source.js",
    "scripts/verify-timeweb-deployment-contract.js",
    "deploy/timeweb/operator-node-bootstrap.v1.json",
    "deploy/timeweb/target.json",
    "docs/runbooks/timeweb-lk2-beta.md",
)
SHA40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
PACKAGE_NAME = re.compile(r"^[a-z0-9][a-z0-9+.-]+$")
SIMULATED_INSTALL = re.compile(r"^Inst\s+(\S+?)(?::\S+)?(?:\s+\[[^]]+\])?\s+\((\S+)")
SIMULATED_UPGRADE = re.compile(r"^Inst\s+\S+(?::\S+)?\s+\[[^]]+\]\s+\(")
SIMULATED_CONFIGURE = re.compile(r"^Conf\s+(\S+?)(?::\S+)?\s+\((\S+)")
SIMULATED_REMOVE = re.compile(r"^(?:Remv|Purg)\s+(\S+?)(?::\S+)?(?:\s|$)")
POLICY_BYTES = b"#!/bin/sh\nexit 101\n"
RECOVERABLE_REMOVAL_STATUSES = frozenset({
    "ii ", "iU ", "iF ", "iW ", "it ", "iH ", "ic ",
    "ri ", "rU ", "rF ", "rW ", "rt ", "rH ", "rc ",
    "pi ", "pU ", "pF ", "pW ", "pt ", "pH ", "pc ",
})
SAFE_LIVE_ENVIRONMENT = {
    "HOME": "/root",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "LC_ALL": "C",
}
EXPECTED_PACKAGES = (
    ("libsimdutf31", "8.0.0-1", "amd64"),
    ("libada-url0-3", "3.4.3-1", "amd64"),
    ("libcares2", "1.34.6-1", "amd64"),
    ("libllhttp9.3", "9.3.3~really9.3.0+~cs12.11.8-3build1", "amd64"),
    ("libsimdjson29", "4.2.4-1", "amd64"),
    ("node-corepack", "0.24.0-5build1", "all"),
    ("nodejs", "22.22.1+dfsg+~cs22.19.15-1ubuntu1", "amd64"),
    ("node-xtend", "4.0.2-3", "all"),
    ("node-acorn", "8.16.0+ds+~cs25.18.7-4", "all"),
    ("node-cjs-module-lexer", "1.2.3+dfsg-1", "all"),
    ("node-balanced-match", "2.0.0-1", "all"),
    ("node-brace-expansion", "2.0.1+~1.1.0-2", "all"),
    ("node-minimatch", "9.0.3-6", "all"),
    ("node-ms", "2.1.3+~cs0.7.31-3", "all"),
    ("node-debug", "4.4.3+~4.1.13-1", "all"),
    ("node-lru-cache", "10.0.1-3", "all"),
    ("node-semver", "7.6.1+~7.5.8-2", "all"),
    ("node-llhttp", "9.3.3~really9.3.0+~cs12.11.8-3build1", "all"),
    ("node-undici", "7.18.2+dfsg+~cs3.2.0-1build1", "all"),
    ("libnode127", "22.22.1+dfsg+~cs22.19.15-1ubuntu1", "amd64"),
)


class Stop(RuntimeError):
    pass


def stop(code: str) -> None:
    raise Stop(code)


def exact_keys(value: Any, expected: set[str], code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        stop(code)
    return value


def unique_strings(value: Any, code: str) -> list[str]:
    if (
        not isinstance(value, list)
        or not value
        or any(not isinstance(item, str) or not item for item in value)
        or len(set(value)) != len(value)
    ):
        stop(code)
    return value


def strict_json_bytes(contents: bytes, code: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                stop(code)
            result[key] = value
        return result

    try:
        text = contents.decode("utf-8")
        if "\x00" in text or "\r" in text or not text.endswith("\n"):
            stop(code)
        return json.loads(text, object_pairs_hook=pairs)
    except (UnicodeDecodeError, json.JSONDecodeError):
        stop(code)


def read_json(path: Path, code: str, *, secure: bool = False) -> Any:
    if secure:
        require_secure_file(path, 0o600, code)
    try:
        return strict_json_bytes(path.read_bytes(), code)
    except OSError:
        stop(code)


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        stop("hash_read")
    return digest.hexdigest()


def require_secure_directory(path: Path, mode: int | None, code: str) -> os.stat_result:
    try:
        value = path.lstat()
    except OSError:
        stop(code)
    if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode) or value.st_uid != 0:
        stop(code)
    if value.st_mode & 0o022 or (mode is not None and stat.S_IMODE(value.st_mode) != mode):
        stop(code)
    if path.resolve() != path:
        stop(code)
    return value


def require_secure_file(path: Path, mode: int | None, code: str) -> os.stat_result:
    try:
        value = path.lstat()
    except OSError:
        stop(code)
    if (
        not stat.S_ISREG(value.st_mode)
        or stat.S_ISLNK(value.st_mode)
        or value.st_uid != 0
        or value.st_nlink != 1
        or value.st_mode & 0o022
        or (mode is not None and stat.S_IMODE(value.st_mode) != mode)
        or path.resolve() != path
    ):
        stop(code)
    return value


def atomic_json(path: Path, value: Any, mode: int = 0o600) -> None:
    parent = path.parent
    require_secure_directory(parent, None, "state_parent_security")
    payload = canonical_bytes(value)
    temporary = parent / f".{path.name}.{os.getpid()}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def run(command: list[str], *, extra_environment: dict[str, str] | None = None) -> str:
    environment = dict(SAFE_LIVE_ENVIRONMENT)
    if extra_environment:
        environment.update(extra_environment)
    try:
        completed = subprocess.run(
            command,
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="strict",
            env=environment,
        )
    except (OSError, UnicodeError, subprocess.CalledProcessError) as error:
        name = Path(command[0]).name if command else "command"
        stop(f"command_failed_{name}")
    return completed.stdout


def validate_contract(value: Any) -> dict[str, Any]:
    contract = exact_keys(
        value,
        {"schema", "platform", "launcher", "apt", "lifecycle", "state", "node"},
        "contract_keys",
    )
    if contract["schema"] != SCHEMA:
        stop("contract_schema")

    target_platform = exact_keys(
        contract["platform"],
        {"osReleaseId", "osReleaseVersion", "osReleaseCodename", "architecture", "hostArchitecture"},
        "contract_platform",
    )
    if target_platform != {
        "osReleaseId": "ubuntu",
        "osReleaseVersion": "26.04",
        "osReleaseCodename": "resolute",
        "architecture": "amd64",
        "hostArchitecture": "x86_64",
    }:
        stop("contract_platform")

    launcher = exact_keys(
        contract["launcher"], {"path", "packageOwner", "major", "flags"}, "contract_launcher"
    )
    if launcher != {
        "path": "/usr/bin/python3", "packageOwner": "python3-minimal", "major": 3,
        "flags": ["-I", "-S", "-B"],
    }:
        stop("contract_launcher")

    apt = exact_keys(
        contract["apt"],
        {
            "binary", "cacheBinary", "configBinary", "dpkgBinary", "dpkgQueryBinary",
            "dpkgDebBinary", "sourceList", "sourceListSha256", "sourceParts", "keyring",
            "keyringSha256", "keyFingerprints", "allowedUris", "allowedSuites",
            "allowedComponents", "packages",
        },
        "contract_apt",
    )
    fixed_binaries = {
        "binary": "/usr/bin/apt-get",
        "cacheBinary": "/usr/bin/apt-cache",
        "configBinary": "/usr/bin/apt-config",
        "dpkgBinary": "/usr/bin/dpkg",
        "dpkgQueryBinary": "/usr/bin/dpkg-query",
        "dpkgDebBinary": "/usr/bin/dpkg-deb",
        "sourceList": "/etc/apt/sources.list.d/ubuntu.sources",
        "sourceParts": "-",
        "keyring": "/usr/share/keyrings/ubuntu-archive-keyring.gpg",
    }
    if any(apt[key] != expected for key, expected in fixed_binaries.items()):
        stop("contract_apt_paths")
    if (
        apt["sourceListSha256"] != "18183d5067de450288aea132d12ea3e01d456196a179b6c1184f9d7e7d20ece0"
        or apt["keyringSha256"] != "80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31"
        or not HEX64.fullmatch(apt["sourceListSha256"] or "")
        or not HEX64.fullmatch(apt["keyringSha256"] or "")
    ):
        stop("contract_apt_hashes")
    if unique_strings(apt["keyFingerprints"], "contract_apt_fingerprints") != [
        "790BC7277767219C42C86F933B4FE6ACC0B21F32",
        "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
        "F6ECB3762474EDA9D21B7022871920D1991BC93C",
    ]:
        stop("contract_apt_fingerprints")
    if unique_strings(apt["allowedUris"], "contract_apt_uris") != [
        "http://archive.ubuntu.com/ubuntu", "http://security.ubuntu.com/ubuntu"
    ]:
        stop("contract_apt_uris")
    if unique_strings(apt["allowedSuites"], "contract_apt_suites") != [
        "resolute", "resolute-updates", "resolute-backports", "resolute-security"
    ]:
        stop("contract_apt_suites")
    if unique_strings(apt["allowedComponents"], "contract_apt_components") != [
        "main", "universe", "restricted", "multiverse"
    ]:
        stop("contract_apt_components")
    packages = apt["packages"]
    if not isinstance(packages, list) or len(packages) != 20:
        stop("contract_packages")
    seen: set[str] = set()
    for package in packages:
        item = exact_keys(package, {"name", "version", "architecture"}, "contract_package")
        if (
            not PACKAGE_NAME.fullmatch(item.get("name", ""))
            or not isinstance(item.get("version"), str)
            or not item["version"]
            or item.get("architecture") not in {"amd64", "all"}
            or item["name"] in seen
        ):
            stop("contract_package")
        seen.add(item["name"])
    if tuple((item["name"], item["version"], item["architecture"]) for item in packages) != EXPECTED_PACKAGES:
        stop("contract_packages")

    lifecycle = exact_keys(
        contract["lifecycle"],
        {
            "policyRcPath", "policyRcPendingPath", "protectedUnits",
            "listenerSnapshotBinary", "rebootRequiredPath",
        },
        "contract_lifecycle",
    )
    if (
        lifecycle["policyRcPath"] != "/usr/sbin/policy-rc.d"
        or lifecycle["policyRcPendingPath"] != "/usr/sbin/.phub-policy-rc.d.pending"
        or lifecycle["listenerSnapshotBinary"] != "/usr/bin/ss"
        or lifecycle["rebootRequiredPath"] != "/var/run/reboot-required"
        or unique_strings(lifecycle["protectedUnits"], "contract_units")
        != ["docker.service", "ssh.service", "tailscaled.service"]
    ):
        stop("contract_lifecycle")

    state = exact_keys(
        contract["state"],
        {
            "root", "pendingDirectory", "bundleDirectory", "planPath", "packageDirectory",
            "listsDirectory", "transactionPath", "receiptPath", "rollbackReceiptPath",
        },
        "contract_state",
    )
    root = "/opt/phub/timeweb-beta/operator/node-bootstrap"
    if state != {
        "root": root,
        "pendingDirectory": f"{root}/pending",
        "bundleDirectory": f"{root}/accepted",
        "planPath": f"{root}/accepted/plan.json",
        "packageDirectory": f"{root}/accepted/packages",
        "listsDirectory": f"{root}/accepted/lists",
        "transactionPath": f"{root}/transaction.json",
        "receiptPath": "/opt/phub/timeweb-beta/operator/node-bootstrap-receipt.json",
        "rollbackReceiptPath": "/opt/phub/timeweb-beta/operator/node-bootstrap-rollback-receipt.json",
    }:
        stop("contract_state")

    node = exact_keys(contract["node"], {"path", "package", "major", "platform", "architecture"}, "contract_node")
    if node != {"path": "/usr/bin/node", "package": "nodejs", "major": 22, "platform": "linux", "architecture": "x64"}:
        stop("contract_node")
    return contract


def parse_simulation(contents: str, contract: dict[str, Any], action: str) -> list[dict[str, str]]:
    expected = {item["name"]: item for item in contract["apt"]["packages"]}
    installed: dict[str, str] = {}
    configured: dict[str, str] = {}
    removed: set[str] = set()
    for line in contents.splitlines():
        install = SIMULATED_INSTALL.match(line)
        if install:
            name, version = install.groups()
            if name in installed:
                stop("simulation_duplicate")
            installed[name] = version
        configure = SIMULATED_CONFIGURE.match(line)
        if configure:
            name, version = configure.groups()
            if name in configured:
                stop("simulation_duplicate")
            configured[name] = version
        removal = SIMULATED_REMOVE.match(line)
        if removal:
            removed.add(removal.group(1))
    if action == "install":
        if removed or set(installed) != set(expected) or set(configured) != set(expected):
            stop("simulation_closure")
        if (
            any(installed[name] != expected[name]["version"] for name in installed)
            or any(configured[name] != expected[name]["version"] for name in configured)
        ):
            stop("simulation_version")
        if " upgraded," not in contents or not re.search(r"(?:^|\n)0 upgraded, 20 newly installed, 0 to remove", contents):
            stop("simulation_summary")
        return [expected[name] for name in sorted(expected)]
    if installed or configured or removed != set(expected):
        stop("rollback_simulation_closure")
    return [expected[name] for name in sorted(expected)]


def parse_removal_subset(
    contents: str, contract: dict[str, Any], expected_removed: set[str]
) -> None:
    allowed = {item["name"] for item in contract["apt"]["packages"]}
    installed: set[str] = set()
    configured: set[str] = set()
    removed: set[str] = set()
    for line in contents.splitlines():
        install = SIMULATED_INSTALL.match(line)
        if install:
            installed.add(install.group(1))
        configure = SIMULATED_CONFIGURE.match(line)
        if configure:
            configured.add(configure.group(1))
        removal = SIMULATED_REMOVE.match(line)
        if removal:
            removed.add(removal.group(1))
    if installed or configured or not removed.issubset(allowed) or removed != expected_removed:
        stop("recovery_rollback_simulation")


def parse_install_subset(
    contents: str,
    contract: dict[str, Any],
    absent: set[str],
    partial: set[str],
) -> None:
    expected = {item["name"]: item for item in contract["apt"]["packages"]}
    installed: dict[str, str] = {}
    configured: dict[str, str] = {}
    removed: set[str] = set()
    for line in contents.splitlines():
        install = SIMULATED_INSTALL.match(line)
        if install:
            name, version = install.groups()
            if name in installed or name in configured or SIMULATED_UPGRADE.match(line):
                stop("recovery_apply_simulation")
            installed[name] = version
        configure = SIMULATED_CONFIGURE.match(line)
        if configure:
            name, version = configure.groups()
            if name in configured:
                stop("recovery_apply_simulation")
            configured[name] = version
        removal = SIMULATED_REMOVE.match(line)
        if removal:
            removed.add(removal.group(1))
    actions = set(installed) | set(configured)
    required = absent | partial
    if (
        removed
        or not absent.issubset(installed)
        or set(configured) != required
        or actions != required
        or any(expected.get(name, {}).get("version") != version for name, version in installed.items())
        or any(expected.get(name, {}).get("version") != version for name, version in configured.items())
        or not re.search(
            rf"(?:^|\n)0 upgraded, {len(absent)} newly installed, 0 to remove", contents
        )
    ):
        stop("recovery_apply_simulation")


def parse_os_release() -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                result[key] = value.strip('"')
    except OSError:
        stop("os_release")
    return result


def git(command: list[str]) -> str:
    return run([
        "/usr/bin/git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
        "-C", str(REPOSITORY_ROOT), *command,
    ], extra_environment={
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_NO_REPLACE_OBJECTS": "1", "GIT_NO_LAZY_FETCH": "1",
    }).strip("\n")


def validate_frozen_source(source_sha: str, source_tree: str) -> None:
    if not SHA40.fullmatch(source_sha) or not SHA40.fullmatch(source_tree):
        stop("source_identity")
    expected_root = re.compile(rf"^/opt/phub/timeweb-beta/releases/{source_sha}-[1-9][0-9]*-1/source$")
    if not expected_root.fullmatch(str(REPOSITORY_ROOT)):
        stop("source_release_path")
    current = REPOSITORY_ROOT
    while True:
        require_secure_directory(current, None, "source_path_security")
        if current == Path("/opt"):
            break
        if current.parent == current:
            stop("source_path_security")
        current = current.parent
    marker = REPOSITORY_ROOT / ".git"
    try:
        marker_stat = marker.lstat()
    except OSError:
        stop("source_git_metadata")
    if (
        marker_stat.st_uid != 0
        or marker_stat.st_mode & 0o022
        or stat.S_ISLNK(marker_stat.st_mode)
        or not (stat.S_ISDIR(marker_stat.st_mode) or stat.S_ISREG(marker_stat.st_mode))
    ):
        stop("source_git_metadata")
    git_directory = Path(git(["rev-parse", "--absolute-git-dir"])).resolve()
    common_directory_output = Path(git(["rev-parse", "--git-common-dir"]))
    common_directory = (
        common_directory_output
        if common_directory_output.is_absolute()
        else (REPOSITORY_ROOT / common_directory_output)
    ).resolve()
    require_secure_directory(git_directory, None, "source_git_directory")
    require_secure_directory(common_directory, None, "source_git_common_directory")
    for metadata in {
        git_directory / "HEAD",
        git_directory / "index",
        common_directory / "config",
    }:
        require_secure_file(metadata, None, "source_git_metadata")
    alternates = common_directory / "objects/info/alternates"
    if alternates.exists() or alternates.is_symlink():
        stop("source_git_alternates")
    if git(["rev-parse", "--show-toplevel"]) != str(REPOSITORY_ROOT):
        stop("source_toplevel")
    if git(["rev-parse", "--verify", "HEAD"]) != source_sha:
        stop("source_head")
    if git(["rev-parse", "--verify", "HEAD^{tree}"]) != source_tree:
        stop("source_tree")
    if git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]):
        stop("source_not_clean")
    object_ids = [source_sha, source_tree]
    for relative in PROTECTED_PATHS:
        path = REPOSITORY_ROOT / relative
        parent = path.parent
        while parent != REPOSITORY_ROOT:
            require_secure_directory(parent, None, "source_protected_directory")
            parent = parent.parent
        require_secure_file(path, None, "source_protected_file")
        entry = git(["ls-tree", "-z", source_sha, "--", relative])
        match = re.fullmatch(r"(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0?", entry)
        if not match or match.group(3) != relative:
            stop("source_tree_entry")
        contents = path.read_bytes()
        blob = hashlib.sha1(f"blob {len(contents)}\0".encode() + contents).hexdigest()
        executable = bool(path.stat().st_mode & 0o111)
        if blob != match.group(2) or executable != (match.group(1) == "100755"):
            stop("source_blob")
        object_ids.append(blob)
    objects = common_directory / "objects"
    require_secure_directory(objects, None, "source_git_objects")
    pack = objects / "pack"
    if pack.exists():
        require_secure_directory(pack, None, "source_git_pack")
        for path in pack.iterdir():
            require_secure_file(path, None, "source_git_pack")
    for object_id in object_ids:
        loose = objects / object_id[:2] / object_id[2:]
        if loose.exists():
            require_secure_file(loose, None, "source_git_object")
        elif not pack.exists() or not any(pack.iterdir()):
            stop("source_git_object")


def require_secure_launcher(path: Path) -> Path:
    try:
        link = path.lstat()
        resolved = path.resolve(strict=True)
        target = resolved.stat()
    except OSError:
        stop("launcher_security")
    link_is_symlink = stat.S_ISLNK(link.st_mode)
    if (
        link.st_uid != 0
        or (not link_is_symlink and not stat.S_ISREG(link.st_mode))
        or (not link_is_symlink and link.st_mode & 0o022)
        or target.st_uid != 0
        or target.st_mode & 0o022
        or not stat.S_ISREG(target.st_mode)
    ):
        stop("launcher_security")
    return resolved


def validate_launcher(contract: dict[str, Any]) -> None:
    launcher = contract["launcher"]
    if Path(sys.executable) != Path(launcher["path"]) or sys.version_info.major != launcher["major"]:
        stop("launcher_identity")
    if (
        sys.flags.isolated != 1
        or sys.flags.no_site != 1
        or sys.flags.dont_write_bytecode != 1
        or getattr(sys.flags, "safe_path", 0) != 1
    ):
        stop("launcher_flags")
    path = Path(launcher["path"])
    require_secure_launcher(path)
    owner = run([contract["apt"]["dpkgQueryBinary"], "-S", launcher["path"]]).split(":", 1)[0]
    if owner != launcher["packageOwner"]:
        stop("launcher_package_owner")


def validate_live_environment() -> None:
    if os.geteuid() != 0:
        stop("root_required")
    if dict(os.environ) != SAFE_LIVE_ENVIRONMENT:
        stop("clean_environment_required")


def apt_options(
    contract: dict[str, Any],
    package_directory: Path | None = None,
    lists_directory: Path | None = None,
) -> list[str]:
    apt = contract["apt"]
    selected_lists = lists_directory or Path(contract["state"]["listsDirectory"])
    result = [
        "-o", "Dir::Etc::main=/dev/null",
        "-o", "Dir::Etc::parts=-",
        "-o", f"Dir::Etc::sourcelist={apt['sourceList']}",
        "-o", f"Dir::Etc::sourceparts={apt['sourceParts']}",
        "-o", f"Dir::State::lists={selected_lists}",
        "-o", "DPkg::Lock::Timeout=30",
        "-o", "Acquire::Languages=none",
        "-o", "Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false",
        "-o", "Acquire::IndexTargets::deb::CNF::DefaultEnabled=false",
        "-o", "APT::Get::AllowUnauthenticated=false",
        "-o", "Acquire::AllowInsecureRepositories=false",
        "-o", "Acquire::AllowDowngradeToInsecureRepositories=false",
    ]
    if package_directory is not None:
        result.extend(["-o", f"Dir::Cache::archives={package_directory}"])
    return result


def validate_apt_trust(contract: dict[str, Any]) -> dict[str, str]:
    apt = contract["apt"]
    source = Path(apt["sourceList"])
    keyring = Path(apt["keyring"])
    require_secure_file(source, None, "apt_source_security")
    require_secure_file(keyring, None, "apt_keyring_security")
    source_contents = source.read_text(encoding="utf-8")
    if sha256_file(source) != apt["sourceListSha256"] or re.search(r"(?i)trusted\s*[:=]|allow-insecure", source_contents):
        stop("apt_source_identity")
    for value in apt["allowedUris"] + apt["allowedSuites"] + apt["allowedComponents"]:
        if value not in source_contents:
            stop("apt_source_content")
    if sha256_file(keyring) != apt["keyringSha256"]:
        stop("apt_keyring_identity")
    fingerprints_output = run(["/usr/bin/gpg", "--batch", "--with-colons", "--show-keys", str(keyring)])
    fingerprints = [line.split(":")[9] for line in fingerprints_output.splitlines() if line.startswith("fpr:")]
    if fingerprints != apt["keyFingerprints"]:
        stop("apt_keyring_fingerprints")
    config = run([apt["configBinary"], *apt_options(contract), "dump"])
    forbidden_hooks = re.compile(r"^(?:DPkg|APT)::(?:Pre-Invoke|Post-Invoke|Post-Invoke-Success)", re.MULTILINE)
    if forbidden_hooks.search(config):
        stop("apt_lifecycle_hook")
    return {"sourceSha256": sha256_file(source), "keyringSha256": sha256_file(keyring)}


def apt_lists_snapshot(directory: Path) -> list[dict[str, Any]]:
    require_secure_directory(directory, 0o700, "apt_lists_security")
    accepted_prefixes = (
        "archive.ubuntu.com_ubuntu_dists_resolute",
        "security.ubuntu.com_ubuntu_dists_resolute-security",
    )
    result: list[dict[str, Any]] = []
    inrelease = 0
    packages = 0
    for path in sorted(directory.iterdir()):
        if path.name in {"partial", "auxfiles"}:
            require_secure_directory(path, None, "apt_lists_auxiliary")
            if any(path.iterdir()):
                stop("apt_lists_auxiliary")
            continue
        if path.name == "lock":
            value = require_secure_file(path, None, "apt_lists_lock")
            if value.st_size != 0:
                stop("apt_lists_lock")
            continue
        if not path.name.startswith(accepted_prefixes):
            stop("apt_lists_unexpected")
        if path.name.endswith("_InRelease"):
            inrelease += 1
        elif "_binary-amd64_Packages" in path.name:
            packages += 1
        else:
            stop("apt_lists_target")
        value = require_secure_file(path, None, "apt_lists_security")
        result.append({"file": path.name, "size": value.st_size, "sha256": sha256_file(path)})
    if inrelease != 4 or packages < 4:
        stop("apt_lists_incomplete")
    return result


def expected_pins(contract: dict[str, Any]) -> list[str]:
    return [f"{item['name']}={item['version']}" for item in contract["apt"]["packages"]]


def installed_state(contract: dict[str, Any]) -> dict[str, dict[str, str] | None]:
    result: dict[str, dict[str, str] | None] = {}
    binary = contract["apt"]["dpkgQueryBinary"]
    for package in contract["apt"]["packages"]:
        try:
            completed = subprocess.run(
                [binary, "-W", "-f=${db:Status-Abbrev}\t${Version}\t${Architecture}\n", package["name"]],
                check=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding="utf-8", env=SAFE_LIVE_ENVIRONMENT,
            )
        except OSError:
            stop("dpkg_query")
        if completed.returncode != 0:
            result[package["name"]] = None
            continue
        parts = completed.stdout.rstrip("\n").split("\t")
        if len(parts) != 3:
            stop("dpkg_state")
        result[package["name"]] = {"status": parts[0], "version": parts[1], "architecture": parts[2]}
    return result


def require_absent_closure(state: dict[str, dict[str, str] | None]) -> None:
    if any(value is not None for value in state.values()):
        stop("package_preexisting")


def require_installed_closure(contract: dict[str, Any]) -> dict[str, dict[str, str]]:
    state = installed_state(contract)
    expected = {item["name"]: item for item in contract["apt"]["packages"]}
    for name, value in state.items():
        if value is None or value != {
            "status": "ii ", "version": expected[name]["version"], "architecture": expected[name]["architecture"]
        }:
            stop("installed_closure")
    return state  # type: ignore[return-value]


def recoverable_apply_state(contract: dict[str, Any]) -> tuple[set[str], set[str]]:
    state = installed_state(contract)
    expected = {item["name"]: item for item in contract["apt"]["packages"]}
    absent: set[str] = set()
    partial: set[str] = set()
    for name, value in state.items():
        if value is None:
            absent.add(name)
            continue
        if (
            value["version"] != expected[name]["version"]
            or value["architecture"] != expected[name]["architecture"]
            or not value["status"].startswith("i")
        ):
            stop("recovery_apply_state")
        if value["status"] != "ii ":
            partial.add(name)
    return absent, partial


def dpkg_audit(contract: dict[str, Any]) -> str:
    return run([contract["apt"]["dpkgBinary"], "--audit"])


def service_snapshot(contract: dict[str, Any]) -> dict[str, Any]:
    units: dict[str, str] = {}
    for unit in contract["lifecycle"]["protectedUnits"]:
        observed = run([
            "/usr/bin/systemctl", "show", unit,
            "--property=Id,ActiveState,SubState,MainPID,ExecMainStartTimestampMonotonic",
        ])
        units[unit] = "\n".join(sorted(observed.splitlines())) + "\n"
    listeners = run([contract["lifecycle"]["listenerSnapshotBinary"], "-H", "-lntup"])
    normalized_listeners = "\n".join(sorted(listeners.splitlines())) + "\n"
    return {"units": units, "listenersSha256": sha256_bytes(normalized_listeners.encode())}


def reboot_state(contract: dict[str, Any]) -> bool:
    return Path(contract["lifecycle"]["rebootRequiredPath"]).exists()


def simulation(
    contract: dict[str, Any], package_directory: Path | None = None,
    lists_directory: Path | None = None, *, local: bool = False
) -> str:
    arguments = [
        contract["apt"]["binary"],
        *apt_options(contract, package_directory, lists_directory),
        "--simulate", "install", "--no-install-recommends",
    ]
    if local:
        arguments.extend(str(path) for path in package_files(contract, package_directory or Path("/invalid")))
    else:
        arguments.extend(expected_pins(contract))
    output = run(arguments)
    parse_simulation(output, contract, "install")
    return output


def validate_uri_plan(contents: str, contract: dict[str, Any]) -> None:
    lines = [line for line in contents.splitlines() if line.startswith("'")]
    if len(lines) != len(contract["apt"]["packages"]):
        stop("package_uri_count")
    names: set[str] = set()
    allowed = tuple(f"'{uri.rstrip('/')}/" for uri in contract["apt"]["allowedUris"])
    for line in lines:
        if not line.startswith(allowed):
            stop("package_uri_origin")
        fields = line.split()
        if len(fields) < 4 or not fields[1].endswith(".deb") or ":" not in fields[3]:
            stop("package_uri_metadata")
        filename = fields[1]
        matched = [item["name"] for item in contract["apt"]["packages"] if filename.startswith(f"{item['name']}_")]
        if len(matched) != 1 or matched[0] in names:
            stop("package_uri_closure")
        names.add(matched[0])
    if names != {item["name"] for item in contract["apt"]["packages"]}:
        stop("package_uri_closure")


def package_files(contract: dict[str, Any], directory: Path) -> list[Path]:
    require_secure_directory(directory, 0o700, "package_directory_security")
    entries = sorted(directory.iterdir())
    paths: list[Path] = []
    for path in entries:
        if path.name.endswith(".deb"):
            paths.append(path)
        elif path.name == "lock":
            value = require_secure_file(path, None, "package_lock_security")
            if value.st_size != 0:
                stop("package_lock_security")
        elif path.name == "partial":
            require_secure_directory(path, None, "package_partial_security")
            if any(path.iterdir()):
                stop("package_partial_security")
        else:
            stop("package_artifact_unexpected")
    if len(paths) != len(contract["apt"]["packages"]):
        stop("package_artifact_count")
    return paths


def inspect_artifacts(contract: dict[str, Any], directory: Path) -> list[dict[str, str]]:
    expected = {item["name"]: item for item in contract["apt"]["packages"]}
    artifacts: dict[str, dict[str, str]] = {}
    for path in package_files(contract, directory):
        require_secure_file(path, 0o600, "package_artifact_security")
        metadata = run([
            contract["apt"]["dpkgDebBinary"], "--field", str(path), "Package", "Version", "Architecture"
        ]).splitlines()
        if len(metadata) != 3:
            stop("package_artifact_metadata")
        name, version, architecture = metadata
        if name not in expected or name in artifacts or expected[name] != {
            "name": name, "version": version, "architecture": architecture
        }:
            stop("package_artifact_metadata")
        payload_listing = run([contract["apt"]["dpkgDebBinary"], "--contents", str(path)])
        if re.search(
            r"\s\./(?:etc/(?:init\.d|systemd)/|lib/systemd/system/|usr/lib/systemd/system/)",
            payload_listing,
        ):
            stop("package_service_payload")
        with tempfile.TemporaryDirectory(prefix=".control-", dir=directory.parent) as control_name:
            control_directory = Path(control_name)
            os.chmod(control_directory, 0o700)
            run([contract["apt"]["dpkgDebBinary"], "--control", str(path), str(control_directory)])
            control_digest = hashlib.sha256()
            for control_path in sorted(control_directory.iterdir()):
                value = control_path.lstat()
                if not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode):
                    stop("package_control_metadata")
                contents = control_path.read_bytes()
                if control_path.name in {"preinst", "postinst", "prerm", "postrm", "config"} and re.search(
                    rb"(?:systemctl|service\s|invoke-rc\.d|deb-systemd-invoke|needrestart|reboot)",
                    contents,
                    re.IGNORECASE,
                ):
                    stop("package_lifecycle_script")
                control_digest.update(control_path.name.encode() + b"\0" + contents)
        artifacts[name] = {
            "name": name, "version": version, "architecture": architecture,
            "file": path.name, "sha256": sha256_file(path),
            "controlSha256": control_digest.hexdigest(),
            "payloadTreeSha256": sha256_bytes(payload_listing.encode()),
        }
    if set(artifacts) != set(expected):
        stop("package_artifact_closure")
    return [artifacts[name] for name in sorted(artifacts)]


def verify_artifacts(contract: dict[str, Any], plan: dict[str, Any]) -> list[Path]:
    directory = Path(contract["state"]["packageDirectory"])
    observed = inspect_artifacts(contract, directory)
    if observed != plan.get("artifacts"):
        stop("package_artifact_drift")
    return [directory / item["file"] for item in observed]


def create_state_root(contract: dict[str, Any]) -> Path:
    root = Path(contract["state"]["root"])
    if root.parent.exists():
        require_secure_directory(root.parent, None, "state_parent_security")
    else:
        require_secure_directory(root.parent.parent, None, "state_grandparent_security")
        root.parent.mkdir(mode=0o700)
    try:
        root.mkdir(mode=0o700)
    except FileExistsError:
        require_secure_directory(root, 0o700, "state_root_security")
    return root


def path_present(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def require_rollback_receipt_absent(contract: dict[str, Any]) -> None:
    path = Path(contract["state"]["rollbackReceiptPath"])
    if path_present(path):
        stop("rollback_receipt_present")


def plan_mode(contract: dict[str, Any], source_sha: str, source_tree: str) -> dict[str, Any]:
    state = contract["state"]
    require_rollback_receipt_absent(contract)
    if any(
        path_present(Path(state[key]))
        for key in ("bundleDirectory", "transactionPath", "receiptPath")
    ):
        stop("existing_bootstrap_state")
    root = create_state_root(contract)
    pending = Path(state["pendingDirectory"])
    if pending.exists() or pending.is_symlink():
        require_secure_directory(pending, 0o700, "pending_plan_security")
        for child in pending.rglob("*"):
            value = child.lstat()
            if value.st_uid != 0 or value.st_mode & 0o022 or stat.S_ISLNK(value.st_mode):
                stop("pending_plan_security")
        shutil.rmtree(pending)
    trust = validate_apt_trust(contract)
    audit = dpkg_audit(contract)
    if audit:
        stop("dpkg_audit")
    before = installed_state(contract)
    require_absent_closure(before)
    node_path = Path(contract["node"]["path"])
    if node_path.exists() or node_path.is_symlink():
        stop("node_preexisting")
    snapshot = service_snapshot(contract)
    pending.mkdir(mode=0o700)
    package_stage = pending / "packages"
    lists_stage = pending / "lists"
    package_stage.mkdir(mode=0o700)
    (package_stage / "partial").mkdir(mode=0o700)
    lists_stage.mkdir(mode=0o700)
    (lists_stage / "partial").mkdir(mode=0o700)
    try:
        run([
            contract["apt"]["binary"], *apt_options(contract, package_stage, lists_stage),
            "--yes", "update",
        ])
        lists_snapshot = apt_lists_snapshot(lists_stage)
        lists_sha = sha256_bytes(canonical_bytes(lists_snapshot))
        accepted_simulation = simulation(contract, lists_directory=lists_stage)
        uri_output = run([
            contract["apt"]["binary"], *apt_options(contract, package_stage, lists_stage), "--print-uris",
            "--yes", "--download-only", "install", "--no-install-recommends", *expected_pins(contract),
        ])
        validate_uri_plan(uri_output, contract)
        run([
            contract["apt"]["binary"], *apt_options(contract, package_stage, lists_stage), "--yes",
            "--download-only", "install", "--no-install-recommends", *expected_pins(contract),
        ])
        for path in package_stage.iterdir():
            if path.name == "partial":
                continue
            if path.is_file():
                os.chown(path, 0, 0)
                os.chmod(path, 0o600)
        artifacts = inspect_artifacts(contract, package_stage)
        plan: dict[str, Any] = {
            "schema": PLAN_SCHEMA,
            "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "sourceSha": source_sha,
            "sourceTree": source_tree,
            "contractSha256": sha256_file(CONTRACT_PATH),
            "aptTrust": trust,
            "aptListsSha256": lists_sha,
            "aptLists": lists_snapshot,
            "simulationSha256": sha256_bytes(accepted_simulation.encode()),
            "uriPlanSha256": sha256_bytes(uri_output.encode()),
            "preinstalled": before,
            "dpkgAuditSha256": sha256_bytes(audit.encode()),
            "protectedServices": snapshot,
            "rebootRequired": reboot_state(contract),
            "artifacts": artifacts,
        }
        plan["planId"] = sha256_bytes(canonical_bytes(plan))
        atomic_json(pending / "plan.json", plan)
        pending_descriptor = os.open(pending, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(pending_descriptor)
        finally:
            os.close(pending_descriptor)
        os.replace(pending, Path(state["bundleDirectory"]))
        root_descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(root_descriptor)
        finally:
            os.close(root_descriptor)
        return {"status": "PLANNED", "planId": plan["planId"], "packageCount": len(artifacts)}
    finally:
        if pending.exists():
            shutil.rmtree(pending)


def load_plan(contract: dict[str, Any], source_sha: str, source_tree: str) -> dict[str, Any]:
    plan = read_json(Path(contract["state"]["planPath"]), "plan_read", secure=True)
    if not isinstance(plan, dict) or plan.get("schema") != PLAN_SCHEMA:
        stop("plan_schema")
    copy = dict(plan)
    plan_id = copy.pop("planId", None)
    if plan_id != sha256_bytes(canonical_bytes(copy)):
        stop("plan_identity")
    if plan.get("sourceSha") != source_sha or plan.get("sourceTree") != source_tree:
        stop("plan_source_identity")
    if plan.get("contractSha256") != sha256_file(CONTRACT_PATH):
        stop("plan_contract_drift")
    return plan


def revalidate_plan(contract: dict[str, Any], plan: dict[str, Any], *, require_absent: bool) -> None:
    require_rollback_receipt_absent(contract)
    if validate_apt_trust(contract) != plan.get("aptTrust"):
        stop("plan_apt_trust_drift")
    lists_snapshot = apt_lists_snapshot(Path(contract["state"]["listsDirectory"]))
    if (
        lists_snapshot != plan.get("aptLists")
        or sha256_bytes(canonical_bytes(lists_snapshot)) != plan.get("aptListsSha256")
    ):
        stop("plan_apt_lists_drift")
    accepted = simulation(contract)
    if sha256_bytes(accepted.encode()) != plan.get("simulationSha256"):
        stop("plan_simulation_drift")
    if dpkg_audit(contract):
        stop("dpkg_audit")
    if require_absent:
        require_absent_closure(installed_state(contract))
    verify_artifacts(contract, plan)
    local = simulation(contract, Path(contract["state"]["packageDirectory"]), local=True)
    parse_simulation(local, contract, "install")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def policy_paths(contract: dict[str, Any]) -> tuple[Path, Path]:
    lifecycle = contract["lifecycle"]
    return Path(lifecycle["policyRcPath"]), Path(lifecycle["policyRcPendingPath"])


def require_policy_paths_absent(contract: dict[str, Any]) -> None:
    path, pending = policy_paths(contract)
    if path.exists() or path.is_symlink() or pending.exists() or pending.is_symlink():
        stop("policy_rc_preexisting")


def create_policy_guard(contract: dict[str, Any]) -> None:
    path, pending = policy_paths(contract)
    require_policy_paths_absent(contract)
    if path.parent != pending.parent:
        stop("policy_rc_parent")
    require_secure_directory(path.parent, None, "policy_rc_parent_security")
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
    with os.fdopen(descriptor, "wb", closefd=True) as handle:
        os.fchmod(handle.fileno(), 0o755)
        handle.write(POLICY_BYTES)
        handle.flush()
        os.fsync(handle.fileno())
    os.link(pending, path, follow_symlinks=False)
    fsync_directory(path.parent)
    pending.unlink()
    fsync_directory(path.parent)


def require_policy_candidate(path: Path, links: int, code: str) -> os.stat_result:
    try:
        value = path.lstat()
    except OSError:
        stop(code)
    if (
        not stat.S_ISREG(value.st_mode)
        or stat.S_ISLNK(value.st_mode)
        or value.st_uid != 0
        or value.st_nlink != links
        or stat.S_IMODE(value.st_mode) != 0o755
        or path.resolve() != path
    ):
        stop(code)
    return value


def recover_policy_guard(contract: dict[str, Any]) -> None:
    path, pending = policy_paths(contract)
    if path.parent != pending.parent:
        stop("policy_rc_parent")
    require_secure_directory(path.parent, None, "policy_rc_parent_security")
    path_present = path.exists() or path.is_symlink()
    pending_present = pending.exists() or pending.is_symlink()
    if path_present and not pending_present:
        require_policy_guard(contract)
        return
    if not path_present and not pending_present:
        create_policy_guard(contract)
        require_policy_guard(contract)
        return
    if not path_present and pending_present:
        require_policy_candidate(pending, 1, "policy_rc_pending_security")
        pending.unlink()
        fsync_directory(pending.parent)
        create_policy_guard(contract)
        require_policy_guard(contract)
        return
    path_state = require_policy_candidate(path, 2, "policy_rc_security")
    pending_state = require_policy_candidate(pending, 2, "policy_rc_pending_security")
    if (path_state.st_dev, path_state.st_ino) != (pending_state.st_dev, pending_state.st_ino):
        stop("policy_rc_pending_identity")
    if path.read_bytes() != POLICY_BYTES:
        stop("policy_rc_identity")
    pending.unlink()
    fsync_directory(pending.parent)
    require_policy_guard(contract)


def require_policy_guard(contract: dict[str, Any]) -> None:
    path = Path(contract["lifecycle"]["policyRcPath"])
    require_secure_file(path, 0o755, "policy_rc_security")
    if path.read_bytes() != POLICY_BYTES:
        stop("policy_rc_identity")


def remove_policy_guard(contract: dict[str, Any]) -> None:
    require_policy_guard(contract)
    path, pending = policy_paths(contract)
    if pending.exists() or pending.is_symlink():
        stop("policy_rc_pending_present")
    path.unlink()
    fsync_directory(path.parent)


def transaction_write(contract: dict[str, Any], value: dict[str, Any]) -> None:
    atomic_json(Path(contract["state"]["transactionPath"]), value)


def transaction_completed_at(
    contract: dict[str, Any], transaction: dict[str, Any], key: str, code: str
) -> str:
    value = transaction.get(key)
    if value is None:
        value = dt.datetime.now(dt.timezone.utc).isoformat()
        transaction[key] = value
        transaction_write(contract, transaction)
    if not isinstance(value, str) or not value:
        stop(code)
    return value


def persist_exact_receipt(path: Path, value: dict[str, Any], code: str) -> None:
    if path.exists() or path.is_symlink():
        if read_json(path, code, secure=True) != value:
            stop(f"{code}_identity")
    else:
        atomic_json(path, value)


def node_observation(contract: dict[str, Any]) -> dict[str, Any]:
    node = contract["node"]
    path = Path(node["path"])
    try:
        link = path.lstat()
        resolved = path.resolve(strict=True)
        target = resolved.stat()
    except OSError:
        stop("node_path")
    if link.st_uid != 0 or link.st_mode & 0o022 or target.st_uid != 0 or target.st_mode & 0o022 or not stat.S_ISREG(target.st_mode):
        stop("node_path_security")
    owner = run([contract["apt"]["dpkgQueryBinary"], "-S", node["path"]]).split(":", 1)[0]
    if owner != node["package"]:
        stop("node_package_owner")
    observed = strict_json_bytes(run([
        node["path"], "--input-type=module", "-e",
        "console.log(JSON.stringify({execPath:process.execPath,platform:process.platform,architecture:process.arch,version:process.versions.node}))",
    ]).encode(), "node_observation")
    if (
        observed.get("execPath") != node["path"]
        or observed.get("platform") != node["platform"]
        or observed.get("architecture") != node["architecture"]
        or not str(observed.get("version", "")).startswith(f"{node['major']}.")
    ):
        stop("node_identity")
    observed.update({"resolvedPath": str(resolved), "sha256": sha256_file(resolved), "packageOwner": owner})
    return observed


def apply_command(contract: dict[str, Any], paths: list[Path]) -> None:
    run([
        contract["apt"]["binary"], *apt_options(contract, Path(contract["state"]["packageDirectory"])),
        "--no-download", "--no-remove", "--no-upgrade", "--yes", "install",
        "--no-install-recommends", *(str(path) for path in paths),
    ], extra_environment={"DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "l", "NEEDRESTART_SUSPEND": "1"})


def recovery_apply_simulation(
    contract: dict[str, Any], paths: list[Path], *, require_fully_absent: bool = False
) -> str:
    absent, partial = recoverable_apply_state(contract)
    expected = {item["name"] for item in contract["apt"]["packages"]}
    if require_fully_absent and (absent != expected or partial):
        stop("apply_state_drift")
    if not absent and not partial:
        return ""
    output = run([
        contract["apt"]["binary"],
        *apt_options(contract, Path(contract["state"]["packageDirectory"])),
        "--simulate", "--no-remove", "--no-upgrade", "install", "--no-install-recommends",
        *(str(path) for path in paths),
    ])
    parse_install_subset(output, contract, absent, partial)
    return output


def purge_command(contract: dict[str, Any], packages: set[str]) -> None:
    if packages:
        run([
            contract["apt"]["dpkgBinary"], "--purge", *sorted(packages)
        ], extra_environment={"DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "l", "NEEDRESTART_SUSPEND": "1"})


def removal_simulation(contract: dict[str, Any], packages: set[str]) -> str:
    if not packages:
        return ""
    output = run([
        contract["apt"]["binary"], *apt_options(contract),
        "--simulate", "purge", *sorted(packages),
    ])
    parse_removal_subset(output, contract, packages)
    return output


def recoverable_present_packages(contract: dict[str, Any]) -> set[str]:
    absent, _partial = recoverable_apply_state(contract)
    return {item["name"] for item in contract["apt"]["packages"]} - absent


def recoverable_removal_present_packages(contract: dict[str, Any]) -> set[str]:
    state = installed_state(contract)
    expected = {item["name"]: item for item in contract["apt"]["packages"]}
    present: set[str] = set()
    for name, value in state.items():
        if value is None:
            continue
        if (
            value["version"] != expected[name]["version"]
            or value["architecture"] != expected[name]["architecture"]
            or value["status"] not in RECOVERABLE_REMOVAL_STATUSES
        ):
            stop("recovery_removal_state")
        present.add(name)
    return present


def finalize_apply(contract: dict[str, Any], plan: dict[str, Any], transaction: dict[str, Any]) -> dict[str, Any]:
    installed = require_installed_closure(contract)
    node = node_observation(contract)
    lists_snapshot = apt_lists_snapshot(Path(contract["state"]["listsDirectory"]))
    if (
        lists_snapshot != plan.get("aptLists")
        or sha256_bytes(canonical_bytes(lists_snapshot)) != plan.get("aptListsSha256")
    ):
        stop("apt_lists_post_apply_drift")
    if service_snapshot(contract) != transaction["protectedServices"]:
        stop("protected_service_drift")
    if reboot_state(contract) != transaction["rebootRequired"]:
        stop("reboot_requirement_drift")
    completed_at = transaction_completed_at(
        contract, transaction, "applyCompletedAt", "apply_completion"
    )
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "status": "INSTALLED",
        "completedAt": completed_at,
        "planId": plan["planId"],
        "sourceSha": plan["sourceSha"],
        "sourceTree": plan["sourceTree"],
        "contractSha256": plan["contractSha256"],
        "aptTrust": plan["aptTrust"],
        "aptListsSha256": plan["aptListsSha256"],
        "aptLists": plan["aptLists"],
        "simulationSha256": plan["simulationSha256"],
        "uriPlanSha256": plan["uriPlanSha256"],
        "artifacts": plan["artifacts"],
        "installed": installed,
        "node": node,
        "protectedServices": transaction["protectedServices"],
        "rebootRequired": transaction["rebootRequired"],
    }
    persist_exact_receipt(
        Path(contract["state"]["receiptPath"]), receipt, "apply_receipt"
    )
    remove_policy_guard(contract)
    Path(contract["state"]["transactionPath"]).unlink()
    return {"status": "INSTALLED", "planId": plan["planId"], "nodeSha256": node["sha256"]}


def apply_mode(contract: dict[str, Any], source_sha: str, source_tree: str) -> dict[str, Any]:
    transaction_path = Path(contract["state"]["transactionPath"])
    if path_present(transaction_path):
        stop("transaction_present_use_recover")
    receipt_path = Path(contract["state"]["receiptPath"])
    if path_present(receipt_path):
        stop("receipt_present")
    require_policy_paths_absent(contract)
    plan = load_plan(contract, source_sha, source_tree)
    revalidate_plan(contract, plan, require_absent=True)
    paths = verify_artifacts(contract, plan)
    transaction = {
        "schema": TRANSACTION_SCHEMA, "operation": "apply", "phase": "prepared",
        "planId": plan["planId"], "sourceSha": source_sha, "sourceTree": source_tree,
        "protectedServices": service_snapshot(contract), "rebootRequired": reboot_state(contract),
    }
    transaction_write(contract, transaction)
    create_policy_guard(contract)
    execution_simulation = recovery_apply_simulation(contract, paths, require_fully_absent=True)
    transaction["executionSimulationSha256"] = sha256_bytes(execution_simulation.encode())
    transaction["phase"] = "installing"
    transaction_write(contract, transaction)
    apply_command(contract, paths)
    transaction["phase"] = "installed"
    transaction_write(contract, transaction)
    try:
        return finalize_apply(contract, plan, transaction)
    except Stop as error:
        transaction["phase"] = (
            "cleanup_required"
            if path_present(Path(contract["state"]["receiptPath"]))
            else "postcondition_failed"
        )
        transaction["failureReason"] = str(error)
        transaction_write(contract, transaction)
        stop(str(error))


def finalize_rollback(
    contract: dict[str, Any], receipt: dict[str, Any], transaction: dict[str, Any]
) -> dict[str, Any]:
    require_absent_closure(installed_state(contract))
    node_path = Path(contract["node"]["path"])
    if node_path.exists() or node_path.is_symlink():
        stop("node_remains_after_rollback")
    if service_snapshot(contract) != transaction["protectedServices"] or reboot_state(contract) != transaction["rebootRequired"]:
        stop("rollback_runtime_drift")
    original_receipt = original_install_receipt(receipt, transaction)
    packages = sorted(item["name"] for item in contract["apt"]["packages"])
    validate_normal_rollback_evidence(contract, transaction)
    completed_at = transaction_completed_at(
        contract, transaction, "rollbackCompletedAt", "rollback_completion"
    )
    rollback_receipt = {
        "schema": ROLLBACK_SCHEMA, "status": "ROLLED_BACK",
        "completedAt": completed_at,
        "planId": receipt["planId"], "sourceSha": transaction["sourceSha"],
        "sourceTree": transaction["sourceTree"],
        "authorizedSimulationSha256": transaction["authorizedSimulationSha256"],
        "authorizedPackages": transaction["authorizedPackages"],
        "latestSimulationSha256": transaction["latestSimulationSha256"],
        "latestSimulationPackages": transaction["latestSimulationPackages"],
        "simulationAttemptCount": transaction["simulationAttemptCount"],
        "removedPackages": packages, "protectedServices": transaction["protectedServices"],
        "rebootRequired": transaction["rebootRequired"],
    }
    persist_exact_receipt(
        Path(contract["state"]["rollbackReceiptPath"]), rollback_receipt, "rollback_receipt"
    )
    completed_receipt = dict(original_receipt)
    completed_receipt["status"] = "ROLLED_BACK"
    completed_receipt["rolledBackAt"] = completed_at
    receipt_path = Path(contract["state"]["receiptPath"])
    if receipt.get("status") == "ROLLED_BACK":
        if receipt != completed_receipt:
            stop("rolled_back_install_receipt_identity")
    else:
        atomic_json(receipt_path, completed_receipt)
    remove_policy_guard(contract)
    Path(contract["state"]["transactionPath"]).unlink()
    return {"status": "ROLLED_BACK", "planId": receipt["planId"], "packageCount": len(packages)}


def original_install_receipt(
    receipt: dict[str, Any], transaction: dict[str, Any]
) -> dict[str, Any]:
    if (
        receipt.get("schema") != RECEIPT_SCHEMA
        or receipt.get("planId") != transaction.get("planId")
        or not HEX64.fullmatch(str(transaction.get("installReceiptSha256", "")))
    ):
        stop("transaction_receipt")
    original = dict(receipt)
    if original.get("status") == "ROLLED_BACK":
        if not isinstance(original.pop("rolledBackAt", None), str):
            stop("transaction_receipt")
        original["status"] = "INSTALLED"
    elif original.get("status") != "INSTALLED":
        stop("transaction_receipt")
    if sha256_bytes(canonical_bytes(original)) != transaction["installReceiptSha256"]:
        stop("transaction_receipt_identity")
    return original


def validate_normal_rollback_evidence(
    contract: dict[str, Any], transaction: dict[str, Any]
) -> tuple[set[str], int]:
    expected = sorted(item["name"] for item in contract["apt"]["packages"])
    latest = transaction.get("latestSimulationPackages")
    count = transaction.get("simulationAttemptCount")
    if (
        transaction.get("authorizedPackages") != expected
        or not HEX64.fullmatch(str(transaction.get("authorizedSimulationSha256", "")))
        or not isinstance(latest, list)
        or latest != sorted(latest)
        or len(set(latest)) != len(latest)
        or not set(latest).issubset(set(expected))
        or not HEX64.fullmatch(str(transaction.get("latestSimulationSha256", "")))
        or not isinstance(count, int)
        or isinstance(count, bool)
        or not 1 <= count <= 32
    ):
        stop("rollback_evidence_identity")
    return set(expected), count


def finalize_failed_apply_rollback(
    contract: dict[str, Any], transaction: dict[str, Any]
) -> dict[str, Any]:
    require_absent_closure(installed_state(contract))
    node_path = Path(contract["node"]["path"])
    if node_path.exists() or node_path.is_symlink():
        stop("node_remains_after_rollback")
    if (
        service_snapshot(contract) != transaction["protectedServices"]
        or reboot_state(contract) != transaction["rebootRequired"]
    ):
        stop("rollback_runtime_drift")
    completed_at = transaction_completed_at(
        contract, transaction, "rollbackCompletedAt", "failed_apply_rollback_completion"
    )
    rollback_receipt = {
        "schema": FAILED_APPLY_ROLLBACK_SCHEMA,
        "status": "FAILED_APPLY_ROLLED_BACK",
        "completedAt": completed_at,
        "planId": transaction["planId"],
        "sourceSha": transaction["sourceSha"],
        "sourceTree": transaction["sourceTree"],
        "originalFailureReason": transaction["originalFailureReason"],
        "authorizedSimulationSha256": transaction["authorizedSimulationSha256"],
        "authorizedPackages": transaction["authorizedPackages"],
        "latestSimulationSha256": transaction["latestSimulationSha256"],
        "latestSimulationPackages": transaction["latestSimulationPackages"],
        "simulationAttemptCount": transaction["simulationAttemptCount"],
        "removedPackages": transaction["authorizedPackages"],
        "protectedServices": transaction["protectedServices"],
        "rebootRequired": transaction["rebootRequired"],
    }
    persist_exact_receipt(
        Path(contract["state"]["rollbackReceiptPath"]),
        rollback_receipt,
        "failed_apply_rollback_receipt",
    )
    remove_policy_guard(contract)
    Path(contract["state"]["transactionPath"]).unlink()
    return {
        "status": "FAILED_APPLY_ROLLED_BACK",
        "planId": transaction["planId"],
        "packageCount": len(transaction["authorizedPackages"]),
    }


def continue_failed_apply_rollback(
    contract: dict[str, Any], transaction: dict[str, Any]
) -> dict[str, Any]:
    if transaction.get("phase") not in {"prepared", "removing", "removed"}:
        stop("transaction_phase")
    allowed = {item["name"] for item in contract["apt"]["packages"]}
    authorized = transaction.get("authorizedPackages")
    latest = transaction.get("latestSimulationPackages")
    attempt_count = transaction.get("simulationAttemptCount")
    if (
        not isinstance(authorized, list)
        or authorized != sorted(authorized)
        or len(set(authorized)) != len(authorized)
        or not set(authorized).issubset(allowed)
        or not isinstance(transaction.get("originalFailureReason"), str)
        or not transaction["originalFailureReason"]
        or not isinstance(transaction.get("protectedServices"), dict)
        or not isinstance(transaction.get("rebootRequired"), bool)
        or not HEX64.fullmatch(str(transaction.get("authorizedSimulationSha256", "")))
        or not isinstance(latest, list)
        or latest != sorted(latest)
        or len(set(latest)) != len(latest)
        or not set(latest).issubset(set(authorized))
        or not HEX64.fullmatch(str(transaction.get("latestSimulationSha256", "")))
        or not isinstance(attempt_count, int)
        or isinstance(attempt_count, bool)
        or not 1 <= attempt_count <= 32
    ):
        stop("failed_apply_rollback_identity")
    if transaction["phase"] != "removed":
        present = recoverable_removal_present_packages(contract)
        if not present.issubset(set(authorized)):
            stop("failed_apply_rollback_scope_drift")
        if attempt_count >= 32:
            stop("failed_apply_rollback_attempt_limit")
        simulated = removal_simulation(contract, present)
        transaction["latestSimulationSha256"] = sha256_bytes(simulated.encode())
        transaction["latestSimulationPackages"] = sorted(present)
        transaction["simulationAttemptCount"] = attempt_count + 1
        transaction["phase"] = "removing"
        transaction_write(contract, transaction)
        purge_command(contract, present)
        transaction["phase"] = "removed"
        transaction_write(contract, transaction)
    return finalize_failed_apply_rollback(contract, transaction)


def failed_apply_rollback_mode(
    contract: dict[str, Any], source_sha: str, source_tree: str
) -> dict[str, Any]:
    transaction = read_json(
        Path(contract["state"]["transactionPath"]), "transaction_read", secure=True
    )
    if (
        not isinstance(transaction, dict)
        or transaction.get("schema") != TRANSACTION_SCHEMA
        or transaction.get("operation") != "apply"
        or transaction.get("phase") != "postcondition_failed"
        or transaction.get("sourceSha") != source_sha
        or transaction.get("sourceTree") != source_tree
    ):
        stop("failed_apply_transaction_identity")
    receipt_path = Path(contract["state"]["receiptPath"])
    rollback_receipt_path = Path(contract["state"]["rollbackReceiptPath"])
    if (
        path_present(receipt_path)
        or path_present(rollback_receipt_path)
    ):
        stop("failed_apply_receipt_present")
    recover_policy_guard(contract)
    plan = load_plan(contract, source_sha, source_tree)
    if transaction.get("planId") != plan.get("planId"):
        stop("transaction_plan")
    verify_artifacts(contract, plan)
    authorized = recoverable_present_packages(contract)
    simulated = removal_simulation(contract, authorized)
    failure_reason = transaction.get("failureReason")
    if not isinstance(failure_reason, str) or not failure_reason:
        stop("failed_apply_failure_reason")
    transaction.update({
        "operation": "failed_apply_rollback",
        "phase": "prepared",
        "originalFailureReason": failure_reason,
        "authorizedPackages": sorted(authorized),
        "authorizedSimulationSha256": sha256_bytes(simulated.encode()),
        "latestSimulationSha256": sha256_bytes(simulated.encode()),
        "latestSimulationPackages": sorted(authorized),
        "simulationAttemptCount": 1,
    })
    transaction_write(contract, transaction)
    return continue_failed_apply_rollback(contract, transaction)


def recover_mode(contract: dict[str, Any], source_sha: str, source_tree: str) -> dict[str, Any]:
    transaction = read_json(Path(contract["state"]["transactionPath"]), "transaction_read", secure=True)
    if not isinstance(transaction, dict) or transaction.get("schema") != TRANSACTION_SCHEMA:
        stop("transaction_identity")
    if transaction.get("sourceSha") != source_sha or transaction.get("sourceTree") != source_tree:
        stop("transaction_source")
    recover_policy_guard(contract)
    if transaction.get("operation") == "apply":
        if transaction.get("phase") not in {
            "prepared", "installing", "installed", "cleanup_required", "postcondition_failed"
        }:
            stop("transaction_phase")
        if transaction.get("phase") == "postcondition_failed":
            stop("failed_apply_rollback_authority_required")
        plan = load_plan(contract, source_sha, source_tree)
        if transaction.get("planId") != plan.get("planId"):
            stop("transaction_plan")
        if transaction.get("phase") == "cleanup_required":
            return finalize_apply(contract, plan, transaction)
        paths = verify_artifacts(contract, plan)
        execution_simulation = recovery_apply_simulation(
            contract, paths, require_fully_absent=transaction["phase"] == "prepared"
        )
        transaction["executionSimulationSha256"] = sha256_bytes(execution_simulation.encode())
        transaction_write(contract, transaction)
        if execution_simulation:
            apply_command(contract, paths)
        transaction["phase"] = "installed"
        transaction_write(contract, transaction)
        try:
            return finalize_apply(contract, plan, transaction)
        except Stop as error:
            transaction["phase"] = (
                "cleanup_required"
                if path_present(Path(contract["state"]["receiptPath"]))
                else "postcondition_failed"
            )
            transaction["failureReason"] = str(error)
            transaction_write(contract, transaction)
            stop(str(error))
    if transaction.get("operation") == "rollback":
        if transaction.get("phase") not in {"prepared", "removing", "removed"}:
            stop("transaction_phase")
        receipt = read_json(Path(contract["state"]["receiptPath"]), "receipt_read", secure=True)
        if not isinstance(receipt, dict):
            stop("transaction_receipt")
        original_install_receipt(receipt, transaction)
        authorized, attempt_count = validate_normal_rollback_evidence(contract, transaction)
        if transaction["phase"] != "removed":
            present = recoverable_removal_present_packages(contract)
            if not present.issubset(authorized):
                stop("rollback_scope_drift")
            if attempt_count >= 32:
                stop("rollback_attempt_limit")
            simulated = removal_simulation(contract, present)
            transaction["latestSimulationSha256"] = sha256_bytes(simulated.encode())
            transaction["latestSimulationPackages"] = sorted(present)
            transaction["simulationAttemptCount"] = attempt_count + 1
            transaction_write(contract, transaction)
            purge_command(contract, present)
            transaction["phase"] = "removed"
            transaction_write(contract, transaction)
        return finalize_rollback(contract, receipt, transaction)
    if transaction.get("operation") == "failed_apply_rollback":
        plan = load_plan(contract, source_sha, source_tree)
        if transaction.get("planId") != plan.get("planId"):
            stop("transaction_plan")
        return continue_failed_apply_rollback(contract, transaction)
    stop("transaction_operation")


def verify_mode(contract: dict[str, Any], source_sha: str, source_tree: str) -> dict[str, Any]:
    if path_present(Path(contract["state"]["transactionPath"])):
        stop("transaction_present_use_recover")
    receipt = read_json(Path(contract["state"]["receiptPath"]), "receipt_read", secure=True)
    if not isinstance(receipt, dict) or receipt.get("schema") != RECEIPT_SCHEMA or receipt.get("status") != "INSTALLED":
        stop("receipt_identity")
    if receipt.get("sourceSha") != source_sha or receipt.get("sourceTree") != source_tree:
        stop("receipt_source")
    plan = load_plan(contract, source_sha, source_tree)
    if receipt.get("planId") != plan.get("planId") or receipt.get("contractSha256") != sha256_file(CONTRACT_PATH):
        stop("receipt_plan")
    require_installed_closure(contract)
    node = node_observation(contract)
    if node != receipt.get("node"):
        stop("node_receipt_drift")
    return {"status": "VERIFIED", "planId": plan["planId"], "nodeSha256": node["sha256"]}


def rollback_mode(
    contract: dict[str, Any], source_sha: str, source_tree: str,
    *, recover_failed_apply: bool = False,
) -> dict[str, Any]:
    if recover_failed_apply:
        return failed_apply_rollback_mode(contract, source_sha, source_tree)
    if path_present(Path(contract["state"]["transactionPath"])):
        stop("transaction_present")
    require_rollback_receipt_absent(contract)
    require_policy_paths_absent(contract)
    receipt = read_json(Path(contract["state"]["receiptPath"]), "receipt_read", secure=True)
    if not isinstance(receipt, dict) or receipt.get("schema") != RECEIPT_SCHEMA or receipt.get("status") != "INSTALLED":
        stop("receipt_identity")
    if receipt.get("sourceSha") != source_sha or receipt.get("sourceTree") != source_tree:
        stop("receipt_source")
    require_installed_closure(contract)
    packages = [item["name"] for item in contract["apt"]["packages"]]
    simulated = removal_simulation(contract, set(packages))
    receipt_sha256 = sha256_bytes(canonical_bytes(receipt))
    transaction = {
        "schema": TRANSACTION_SCHEMA, "operation": "rollback", "phase": "prepared",
        "planId": receipt["planId"], "sourceSha": source_sha, "sourceTree": source_tree,
        "protectedServices": service_snapshot(contract), "rebootRequired": reboot_state(contract),
        "installReceiptSha256": receipt_sha256,
        "authorizedSimulationSha256": sha256_bytes(simulated.encode()),
        "authorizedPackages": sorted(packages),
        "latestSimulationSha256": sha256_bytes(simulated.encode()),
        "latestSimulationPackages": sorted(packages),
        "simulationAttemptCount": 1,
    }
    transaction_write(contract, transaction)
    create_policy_guard(contract)
    transaction["phase"] = "removing"
    transaction_write(contract, transaction)
    purge_command(contract, set(packages))
    transaction["phase"] = "removed"
    transaction_write(contract, transaction)
    return finalize_rollback(contract, receipt, transaction)


def live_contract(source_sha: str | None, source_tree: str | None) -> dict[str, Any]:
    validate_live_environment()
    contract = validate_contract(read_json(CONTRACT_PATH, "contract_read"))
    validate_launcher(contract)
    validate_frozen_source(source_sha or "", source_tree or "")
    if platform.machine() != contract["platform"]["hostArchitecture"]:
        stop("host_architecture")
    release = parse_os_release()
    if (
        release.get("ID") != contract["platform"]["osReleaseId"]
        or release.get("VERSION_ID") != contract["platform"]["osReleaseVersion"]
        or release.get("VERSION_CODENAME") != contract["platform"]["osReleaseCodename"]
    ):
        stop("host_os_release")
    return contract


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("validate-contract", "validate-simulation", "plan", "apply", "verify", "recover", "rollback"))
    parser.add_argument("--contract")
    parser.add_argument("--simulation-file")
    parser.add_argument("--simulation-action", choices=("install", "remove"), default="install")
    parser.add_argument("--expected-source-sha")
    parser.add_argument("--expected-source-tree")
    parser.add_argument("--recover-failed-apply", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = arguments()
    try:
        if args.mode in {"validate-contract", "validate-simulation"}:
            if args.recover_failed_apply:
                stop("live_override_forbidden")
            if not args.contract:
                stop("validation_contract_required")
            contract = validate_contract(read_json(Path(args.contract), "validation_contract_read"))
            if args.mode == "validate-simulation":
                if not args.simulation_file:
                    stop("validation_simulation_required")
                contents = Path(args.simulation_file).read_text(encoding="utf-8")
                closure = parse_simulation(contents, contract, args.simulation_action)
                result = {"status": "VALID", "packageCount": len(closure), "action": args.simulation_action}
            else:
                result = {"status": "VALID", "schema": contract["schema"], "packageCount": len(contract["apt"]["packages"])}
        else:
            if args.contract or args.simulation_file:
                stop("live_override_forbidden")
            if args.recover_failed_apply and args.mode != "rollback":
                stop("failed_apply_rollback_mode_required")
            contract = live_contract(args.expected_source_sha, args.expected_source_tree)
            operation = {
                "plan": plan_mode, "apply": apply_mode, "verify": verify_mode,
                "recover": recover_mode, "rollback": rollback_mode,
            }[args.mode]
            if args.mode == "rollback":
                result = rollback_mode(
                    contract, args.expected_source_sha, args.expected_source_tree,
                    recover_failed_apply=args.recover_failed_apply,
                )
            else:
                result = operation(contract, args.expected_source_sha, args.expected_source_tree)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except Stop as error:
        print(f"STOP {error}", file=sys.stderr)
        return 2
    except (OSError, UnicodeError, ValueError):
        print("STOP unexpected_io", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
