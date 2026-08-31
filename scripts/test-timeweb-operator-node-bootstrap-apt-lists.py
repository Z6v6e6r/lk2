#!/usr/bin/python3
"""Root-only Ubuntu fixture matrix for the operator Node-bootstrap APT lists gate."""

from __future__ import annotations

import importlib.util
import os
import pwd
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


CONTROLLER_PATH = Path(sys.argv[1])
CONTRACT_PATH = Path(sys.argv[2])
OBSERVED_LISTS_PATH = Path(sys.argv[3])
FIXTURE_ROOT = Path("/root/phub-apt-lists-fixtures")


def load_controller() -> Any:
    spec = importlib.util.spec_from_file_location("controller", CONTROLLER_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("controller import spec is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


module = load_controller()


def assert_stop(expected: str, operation: Callable[[], object]) -> None:
    try:
        operation()
    except module.Stop as error:
        if str(error) != expected:
            raise AssertionError(f"expected STOP {expected}, received STOP {error}") from error
    else:
        raise AssertionError(f"expected STOP {expected}")


def write_file(path: Path, contents: bytes = b"fixture\n", mode: int = 0o600) -> None:
    path.write_bytes(contents)
    path.chmod(mode)
    os.chown(path, 0, 0)


def synthetic_fixture(name: str, *, apt_auxiliary_owner: bool = False) -> Path:
    directory = FIXTURE_ROOT / name
    directory.mkdir(mode=0o700)
    auxiliary_modes = {"partial": 0o700, "auxfiles": 0o755}
    for auxiliary, mode in auxiliary_modes.items():
        path = directory / auxiliary
        path.mkdir(mode=mode)
        path.chmod(mode)
        os.chown(path, module.APT_SANDBOX_UID if apt_auxiliary_owner else 0, 0)
    write_file(directory / "lock", b"", 0o640)
    names = (
        "archive.ubuntu.com_ubuntu_dists_resolute_InRelease",
        "archive.ubuntu.com_ubuntu_dists_resolute-updates_InRelease",
        "archive.ubuntu.com_ubuntu_dists_resolute-backports_InRelease",
        "security.ubuntu.com_ubuntu_dists_resolute-security_InRelease",
        "archive.ubuntu.com_ubuntu_dists_resolute_main_binary-amd64_Packages",
        "archive.ubuntu.com_ubuntu_dists_resolute-updates_main_binary-amd64_Packages",
        "archive.ubuntu.com_ubuntu_dists_resolute-backports_universe_binary-amd64_Packages",
        "security.ubuntu.com_ubuntu_dists_resolute-security_main_binary-amd64_Packages",
    )
    for filename in names:
        write_file(directory / filename, filename.encode())
    return directory


def first_target(directory: Path) -> Path:
    return next(
        path
        for path in sorted(directory.iterdir())
        if path.name not in {"partial", "auxfiles", "lock"}
    )


def validate_observed_ubuntu_2604_layout() -> None:
    if pwd.getpwuid(module.APT_SANDBOX_UID).pw_name != "_apt":
        raise AssertionError("Ubuntu 26.04 UID 42 is not the _apt sandbox identity")
    expected = {"partial": 0o700, "auxfiles": 0o755}
    for name, mode in expected.items():
        path = OBSERVED_LISTS_PATH / name
        value = path.lstat()
        if (
            not stat.S_ISDIR(value.st_mode)
            or value.st_uid != module.APT_SANDBOX_UID
            or value.st_gid != 0
            or stat.S_IMODE(value.st_mode) != mode
            or any(path.iterdir())
        ):
            raise AssertionError(f"unexpected Ubuntu 26.04 APT auxiliary layout: {name}")
    module.apt_lists_snapshot(OBSERVED_LISTS_PATH)


def validate_regression_matrix() -> None:
    module.apt_lists_snapshot(synthetic_fixture("existing-root-canonical"))
    module.apt_lists_snapshot(synthetic_fixture("ubuntu-2604-apt-owned", apt_auxiliary_owner=True))

    unknown_auxiliary = synthetic_fixture("unknown-auxiliary")
    write_file(unknown_auxiliary / "auxfiles" / "unexpected")
    assert_stop("apt_lists_auxiliary", lambda: module.apt_lists_snapshot(unknown_auxiliary))

    non_root = synthetic_fixture("non-root-owned")
    os.chown(first_target(non_root), 1000, 0)
    assert_stop("apt_lists_security", lambda: module.apt_lists_snapshot(non_root))

    apt_owned_target = synthetic_fixture("apt-owned-target")
    os.chown(first_target(apt_owned_target), module.APT_SANDBOX_UID, 0)
    assert_stop("apt_lists_security", lambda: module.apt_lists_snapshot(apt_owned_target))

    writable = synthetic_fixture("writable-entry")
    first_target(writable).chmod(0o620)
    assert_stop("apt_lists_security", lambda: module.apt_lists_snapshot(writable))

    suspicious_symlink = synthetic_fixture("suspicious-symlink")
    target = first_target(suspicious_symlink)
    replacement = next(path for path in sorted(suspicious_symlink.iterdir()) if path != target and path.is_file())
    target.unlink()
    target.symlink_to(replacement)
    assert_stop("apt_lists_security", lambda: module.apt_lists_snapshot(suspicious_symlink))

    broken_symlink = synthetic_fixture("broken-symlink")
    target = first_target(broken_symlink)
    target.unlink()
    target.symlink_to(broken_symlink / "missing")
    assert_stop("apt_lists_security", lambda: module.apt_lists_snapshot(broken_symlink))

    escaped_symlink = synthetic_fixture("escaped-symlink")
    target = first_target(escaped_symlink)
    outside = FIXTURE_ROOT / "outside"
    write_file(outside)
    target.unlink()
    target.symlink_to(outside)
    assert_stop("apt_lists_security", lambda: module.apt_lists_snapshot(escaped_symlink))

    unexpected_directory = synthetic_fixture("unexpected-directory")
    target = first_target(unexpected_directory)
    target.unlink()
    target.mkdir(mode=0o700)
    assert_stop("apt_lists_security", lambda: module.apt_lists_snapshot(unexpected_directory))

    malformed = synthetic_fixture("malformed-target")
    write_file(malformed / "archive.ubuntu.com_ubuntu_dists_resolute_Translation-en")
    assert_stop("apt_lists_target", lambda: module.apt_lists_snapshot(malformed))

    mixed = synthetic_fixture("valid-plus-malicious", apt_auxiliary_owner=True)
    write_file(mixed / "unknown_InRelease")
    assert_stop("apt_lists_unexpected", lambda: module.apt_lists_snapshot(mixed))

    wrong_auxiliary_owner = synthetic_fixture("wrong-auxiliary-owner", apt_auxiliary_owner=True)
    os.chown(wrong_auxiliary_owner / "partial", 1000, 0)
    assert_stop("apt_lists_auxiliary", lambda: module.apt_lists_snapshot(wrong_auxiliary_owner))

    writable_auxiliary = synthetic_fixture("writable-auxiliary", apt_auxiliary_owner=True)
    (writable_auxiliary / "auxfiles").chmod(0o775)
    assert_stop("apt_lists_auxiliary", lambda: module.apt_lists_snapshot(writable_auxiliary))

    wrong_auxiliary_group = synthetic_fixture("wrong-auxiliary-group", apt_auxiliary_owner=True)
    os.chown(wrong_auxiliary_group / "partial", module.APT_SANDBOX_UID, 1)
    assert_stop("apt_lists_auxiliary", lambda: module.apt_lists_snapshot(wrong_auxiliary_group))

    wrong_auxiliary_mode = synthetic_fixture("wrong-auxiliary-mode", apt_auxiliary_owner=True)
    (wrong_auxiliary_mode / "auxfiles").chmod(0o700)
    assert_stop("apt_lists_auxiliary", lambda: module.apt_lists_snapshot(wrong_auxiliary_mode))

    auxiliary_symlink = synthetic_fixture("auxiliary-symlink")
    (auxiliary_symlink / "auxfiles").rmdir()
    (auxiliary_symlink / "auxfiles").symlink_to(auxiliary_symlink / "partial")
    assert_stop("apt_lists_auxiliary", lambda: module.apt_lists_snapshot(auxiliary_symlink))

    auxiliary_regular_file = synthetic_fixture("auxiliary-regular-file")
    (auxiliary_regular_file / "auxfiles").rmdir()
    write_file(auxiliary_regular_file / "auxfiles")
    assert_stop("apt_lists_auxiliary", lambda: module.apt_lists_snapshot(auxiliary_regular_file))


def validate_plan_rehearsal() -> None:
    rehearsal = Path("/root/phub-node-bootstrap-plan-rehearsal")
    rehearsal.mkdir(mode=0o700)
    contract = module.validate_contract(module.read_json(CONTRACT_PATH, "contract"))
    contract["state"] = {
        "root": str(rehearsal / "state"),
        "pendingDirectory": str(rehearsal / "state/pending"),
        "bundleDirectory": str(rehearsal / "state/accepted"),
        "planPath": str(rehearsal / "state/accepted/plan.json"),
        "packageDirectory": str(rehearsal / "state/accepted/packages"),
        "listsDirectory": str(rehearsal / "state/accepted/lists"),
        "transactionPath": str(rehearsal / "state/transaction.json"),
        "receiptPath": str(rehearsal / "node-bootstrap-receipt.json"),
        "rollbackReceiptPath": str(rehearsal / "node-bootstrap-rollback-receipt.json"),
    }
    contract["node"]["path"] = str(rehearsal / "absent-node")
    source_sha = "a" * 40
    source_tree = "b" * 40
    package_state_before = subprocess.run(
        [contract["apt"]["dpkgQueryBinary"], "-W", "nodejs"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode
    original_run_apt = module.run_apt

    def rehearsal_run_apt(value: dict[str, Any], command: list[str]) -> str:
        if "update" in command:
            return original_run_apt(value, command)
        if "--print-uris" in command:
            return "rehearsal-uri-plan\n"
        if "--download-only" in command:
            return ""
        raise AssertionError(f"unexpected rehearsal APT command: {command}")

    module.validate_apt_trust = lambda *_args: {}
    module.dpkg_audit = lambda *_args: ""
    module.installed_state = lambda value: {item["name"]: None for item in value["apt"]["packages"]}
    module.service_snapshot = lambda *_args: {"units": {}, "listenersSha256": "0" * 64}
    module.reboot_state = lambda *_args: False
    module.run_apt = rehearsal_run_apt
    module.simulation = lambda *_args, **_kwargs: "rehearsal-simulation\n"
    module.parse_simulation = lambda *_args: None
    module.validate_uri_plan = lambda *_args: None
    module.inspect_artifacts = lambda *_args: []

    result = module.plan_mode(contract, source_sha, source_tree)
    if result.get("status") != "PLANNED" or not result.get("planId"):
        raise AssertionError("plan rehearsal did not publish an accepted plan ID")
    plan = module.load_plan(contract, source_sha, source_tree)
    if plan.get("planId") != result["planId"] or not plan.get("aptLists"):
        raise AssertionError("accepted plan identity or APT lists binding is missing")
    module.revalidate_plan(contract, plan, require_absent=True)
    accepted_auxfiles = Path(contract["state"]["listsDirectory"]) / "auxfiles"
    accepted_auxfiles.chmod(0o700)
    assert_stop(
        "apt_lists_auxiliary",
        lambda: module.revalidate_plan(contract, plan, require_absent=True),
    )
    if Path(contract["state"]["transactionPath"]).exists() or Path(contract["state"]["receiptPath"]).exists():
        raise AssertionError("plan rehearsal crossed the apply boundary")
    package_state_after = subprocess.run(
        [contract["apt"]["dpkgQueryBinary"], "-W", "nodejs"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode
    if package_state_before != package_state_after or Path(contract["node"]["path"]).exists():
        raise AssertionError("plan rehearsal changed the Node package state")


def main() -> None:
    if os.geteuid() != 0:
        raise AssertionError("fixture matrix requires root inside the disposable Ubuntu container")
    shutil.rmtree(FIXTURE_ROOT, ignore_errors=True)
    FIXTURE_ROOT.mkdir(mode=0o700)
    validate_observed_ubuntu_2604_layout()
    validate_regression_matrix()
    validate_plan_rehearsal()
    print(
        "TIMEWEB_NODE_BOOTSTRAP_APT_LISTS status=PASS "
        "ubuntu2604=PASS existing=PASS negative_matrix=PASS plan_rehearsal=PASS host_install=NO"
    )


if __name__ == "__main__":
    main()
