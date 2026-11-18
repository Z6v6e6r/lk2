import pathlib
p=pathlib.Path('.github/workflows/publish-timeweb-amd64-images.yaml')
s=p.read_text()
old='''            (map(select(.predicateType == "https://spdx.dev/Document"))[0].predicate) as $sbom |
            (map(select(.predicateType == "https://slsa.dev/provenance/v1"))[0].predicate) as $provenance |
            (($provenance | type) == "object") and
            (($sbom | type) == "object") and
            length == 2 and'''
assert old in s, 'current binds'
new='''            length == 2 and'''
s=s.replace(old,new,1)
old2='''            ) and
            $sbom.SPDXID == "SPDXRef-DOCUMENT" and
            ($sbom.packages | type == "array" and length > 0)'''
assert old2 in s, 'tail block'
new2='''            ) and
            (
              (map(select(.predicateType == "https://spdx.dev/Document"))[0].predicate) as $sbom |
              (($sbom | type) == "object") and
              $sbom.SPDXID == "SPDXRef-DOCUMENT" and
              ($sbom.packages | type == "array" and length > 0)
            )'''
s=s.replace(old2,new2,1)
p.write_text(s)
print('patched structure')