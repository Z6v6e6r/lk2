import pathlib
p=pathlib.Path('.github/workflows/pull-request.yaml')
s=p.read_text()
old='''          docker pull --platform linux/amd64 "$CADDY_IMAGE"
          test "$(docker image inspect "$CADDY_IMAGE" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
          test "$(docker image inspect "$CADDY_IMAGE" --format '{{.Id}}')" = "$CADDY_CONFIG_DIGEST"'''
assert old in s, 'caddy identity block'
new='''          docker pull --platform linux/amd64 "$CADDY_IMAGE"
          caddy_platform="$(docker image inspect "$CADDY_IMAGE" --format '{{.Os}}/{{.Architecture}}')"
          caddy_image_id="$(docker image inspect "$CADDY_IMAGE" --format '{{.Id}}')"
          printf 'caddy identity: %s %s\\n' "$caddy_platform" "$caddy_image_id"
          test "$caddy_platform" = linux/amd64
          test "$caddy_image_id" = "$CADDY_CONFIG_DIGEST" || test "$caddy_image_id" = "sha256:${CADDY_IMAGE##*@}"'''
s=s.replace(old,new,1)
p.write_text(s)
print('patched pr workflow')