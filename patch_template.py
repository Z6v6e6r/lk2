import pathlib
p = pathlib.Path('.github/workflows/publish-timeweb-amd64-images.yaml')
s = p.read_text()
D = '@@D@@'
old = '''          jq -s -e --arg runtimeSha "''' + D + '''" '
            length == 2 and
            ([.[].predicateType] | sort | unique) == [
              "https://slsa.dev/provenance/v1",
              "https://spdx.dev/Document"
            ] and
            all(.[];
              ._type == "https://in-toto.io/Statement/v1" and
              (.subject | length) == 1 and
              (.subject[0].digest | keys) == ["sha256"] and
              .subject[0].digest.sha256 == $runtimeSha
            ) and
            (map(select(.predicateType == "https://spdx.dev/Document"))[0].predicate) as $sbom |
            $sbom.SPDXID == "SPDXRef-DOCUMENT" and
            ($sbom.packages | type == "array" and length > 0)
          ' publication-evidence/"$SERVICE"-attestation-statements/*.json >/dev/null
'''
new = '''          jq -s -e --arg runtimeSha "''' + D + '''" '
            (map(select(.predicateType == "https://spdx.dev/Document"))[0].predicate) as $sbom |
            (map(select(.predicateType == "https://slsa.dev/provenance/v1"))[0].predicate) as $provenance |
            (($provenance | type) == "object") and
            (($sbom | type) == "object") and
            length == 2 and
            ([.[].predicateType] | sort | unique) == [
              "https://slsa.dev/provenance/v1",
              "https://spdx.dev/Document"
            ] and
            all(.[];
              ._type == "https://in-toto.io/Statement/v1" and
              (.subject | length) == 1 and
              (.subject[0].digest | keys) == ["sha256"] and
              .subject[0].digest.sha256 == $runtimeSha
            ) and
            $sbom.SPDXID == "SPDXRef-DOCUMENT" and
            ($sbom.packages | type == "array" and length > 0)
          ' publication-evidence/"$SERVICE"-attestation-statements/*.json >/dev/null
'''
assert old in s, 'block not found'
s = s.replace(old, new, 1)
p.write_text(s)
print('patched workflow')
