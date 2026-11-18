import pathlib
p=pathlib.Path('.github/workflows/pull-request.yaml')
s=p.read_text()
old='          test "$caddy_image_id" = "$CADDY_CONFIG_DIGEST" || test "$caddy_image_id" = "sha256:${CADDY_IMAGE##*@}"'
assert old in s, 'identity line'
new='          test "$caddy_image_id" = "$CADDY_CONFIG_DIGEST" || test "$caddy_image_id" = "${CADDY_IMAGE##*@}"'
s=s.replace(old,new,1)
p.write_text(s)
print('patched expansion')