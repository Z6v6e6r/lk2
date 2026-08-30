#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
image='ubuntu:26.04@sha256:2260313b31c8c011cd2eebe728008efac1b3982be73eb71348ea2648d2c0e09b'

docker run --rm --platform linux/amd64 \
  --volume "$repository_root:/workspace:ro" \
  "$image" /bin/bash -ceu '
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
apt-get update
apt-get install --yes --no-install-recommends packagekit needrestart update-notifier-common python3-minimal

for hook in \
  /etc/apt/apt.conf.d/20packagekit \
  /etc/apt/apt.conf.d/99needrestart \
  /etc/apt/apt.conf.d/99update-notifier
do
  test -f "$hook"
  dpkg-query -S "$hook"
done

baseline_config=$(apt-config dump)
printf "%s\n" "$baseline_config" | grep -Eq "^(DPkg|APT)(::[^:[:space:]]+)*::(Pre-Invoke|Post-Invoke|Post-Invoke-Success)(::|[[:space:]]|$)"

install -d -o root -g root -m 0755 /opt/phub/test/source/scripts /opt/phub/test/source/deploy/timeweb
install -o root -g root -m 0755 /workspace/scripts/control-timeweb-operator-node-bootstrap.py /opt/phub/test/source/scripts/
install -o root -g root -m 0644 /workspace/deploy/timeweb/operator-node-bootstrap.apt.conf /opt/phub/test/source/deploy/timeweb/
install -o root -g root -m 0644 /workspace/deploy/timeweb/operator-node-bootstrap.v1.json /opt/phub/test/source/deploy/timeweb/

cat >/etc/apt/apt.conf.d/99phub-isolation-sentinel <<"EOF"
DPkg::Post-Invoke { "/usr/bin/touch /tmp/phub-apt-hook-executed"; };
APT::Post-Invoke { "/usr/bin/touch /tmp/phub-apt-hook-executed"; };
EOF
rm -f /tmp/phub-apt-hook-executed

install -d -o root -g root -m 0700 /tmp/phub-lists /tmp/phub-lists/partial
install -d -o root -g root -m 0700 /tmp/phub-archives /tmp/phub-archives/partial
default_lists_before=$(find /var/lib/apt/lists -type f -exec sha256sum {} + | sort | sha256sum)

/usr/bin/python3 -I -S -B - /opt/phub/test/source/scripts/control-timeweb-operator-node-bootstrap.py \
  /opt/phub/test/source/deploy/timeweb/operator-node-bootstrap.v1.json <<"PY"
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("controller", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
contract = module.validate_contract(module.read_json(pathlib.Path(sys.argv[2]), "contract"))

baseline = module.run([contract["apt"]["configBinary"], "dump"])
try:
    module.validate_no_apt_lifecycle_hooks(baseline)
except module.Stop as error:
    if str(error) != "apt_lifecycle_hook":
        raise
else:
    raise AssertionError("stock Ubuntu lifecycle hooks did not fail closed")

options = module.apt_options(
    contract,
    pathlib.Path("/tmp/phub-archives"),
    pathlib.Path("/tmp/phub-lists"),
)
isolated = module.run_apt(contract, [contract["apt"]["configBinary"], *options, "dump"])
module.validate_no_apt_lifecycle_hooks(isolated)
if "Dir::Etc::parts \"-\";" not in isolated or "Dir::Etc::main \"/dev/null\";" not in isolated:
    raise AssertionError("early APT configuration isolation is not effective")

module.run_apt(contract, [contract["apt"]["binary"], *options, "--yes", "update"])
if pathlib.Path("/tmp/phub-apt-hook-executed").exists():
    raise AssertionError("APT update executed a host lifecycle hook")
module.run_apt(contract, [contract["apt"]["binary"], *options, "--simulate", "install", "hello"])
if pathlib.Path("/tmp/phub-apt-hook-executed").exists():
    raise AssertionError("APT simulation executed a host lifecycle hook")
module.run_apt(
    contract,
    [contract["apt"]["binary"], *options, "--yes", "--download-only", "install", "hello"],
)
if pathlib.Path("/tmp/phub-apt-hook-executed").exists():
    raise AssertionError("APT download executed a host lifecycle hook")
PY

test -n "$(find /tmp/phub-lists -type f -print -quit)"
test -n "$(find /tmp/phub-archives -maxdepth 1 -type f -name "hello_*.deb" -print -quit)"
test -z "$(find /var/cache/apt/archives -maxdepth 1 -type f -name "hello_*.deb" -print -quit)"
default_lists_after=$(find /var/lib/apt/lists -type f -exec sha256sum {} + | sort | sha256sum)
test "$default_lists_before" = "$default_lists_after"
test ! -e /tmp/phub-apt-hook-executed
printf "%s\n" "TIMEWEB_NODE_BOOTSTRAP_APT_ISOLATION status=PASS os=ubuntu-26.04 lifecycle=stock update=isolated simulation=isolated download=isolated"
'
