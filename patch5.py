import pathlib,re
p=pathlib.Path('scripts/timeweb-production-cutover.js')
s=p.read_text()
old='''  if (
    value.schema !== CANONICAL_BASELINE_SCHEMA ||
    value.installedReleaseId !== CANONICAL_BASELINE_RELEASE ||
    value.sourceSha !== CANONICAL_BASELINE_SOURCE ||
    value.sourceTree !== '8907550c2386aaddc97b3fbda186dced43db00bd' ||
    value.sourceCiRunId !== '43749601790' ||
    value.publicationRunId !== '43751306581' ||
    value.artifactId !== '14176493246' ||
    value.manifestSha256 !== '15465f17d7d4384ea2392fda664ff438a340389b3c5df29d2bd14d4e5ee82672' ||
    !timestamp(value.capturedAt) ||
    !ID.test(value.secretSetReleaseId ?? '') ||
    value.ledgerSha256 !== '4dab86cb18f7e3db7a0598cd657eaebc86f07d5af497dc0eea2e33900b6526c1' ||'''
assert old in s, 'frozen identity block'
new='''  const frozenIdentity=
    value.installedReleaseId === CANONICAL_BASELINE_RELEASE &&
    value.sourceSha === CANONICAL_BASELINE_SOURCE &&
    value.sourceTree === '8907550c2386aaddc97b3fbda186dced43db00bd' &&
    value.sourceCiRunId === '43749601790' &&
    value.publicationRunId === '43751306581' &&
    value.artifactId === '14176493246' &&
    value.manifestSha256 === '15465f17d7d4384ea2392fda664ff438a340389b3c5df29d2bd14d4e5ee82672';
  // V6: after a canonical upgrade the installed release is the new predecessor. Its custody is
  // attested live by attestCanonicalBaseline; this validator only enforces shape and identity.
  const derivedIdentity =
    /^[0-9a-f]{40}-[1-9][0-9]*-1$/u.test(value.installedReleaseId ?? '') &&
    value.sourceSha === value.installedReleaseId.slice(0, 40) &&
    typeof value.sourceTree === 'string' &&
    /^[0-9a-f]{40}$/u.test(value.sourceTree) &&
    /^[1-9][0-9]*$/u.test(String(value.sourceCiRunId ?? '')) &&
    /^[1-9][0-9]*$/u.test(String(value.publicationRunId ?? '')) &&
    /^[1-9][0-9]*$/u.test(String(value.artifactId ?? '')) &&
    HASH.test(value.manifestSha256 ?? '');
  if (
    value.schema !== CANONICAL_BASELINE_SCHEMA ||
    (!frozenIdentity && !derivedIdentity) ||
    !timestamp(value.capturedAt) ||
    !ID.test(value.secretSetReleaseId ?? '') ||
    value.ledgerSha256 !== '4dab86cb18f7e3db7a0598cd657eaebc86f07d5af497dc0eea2e33900b6526c1' ||'''
s=s.replace(old,new,1)
old2='''      !HASH.test(c.id ?? '') ||
      !image(service, c.image) ||
      c.imageId !== CANONICAL_BASELINE_IMAGES[service] ||
      c.imageId !== c.image.split('@')[1] ||
      c.restarts !== 0 ||
      !timestamp(c.startedAt) ||
      c.releaseId !== (['api', 'web'].includes(service) ? CANONICAL_BASELINE_RELEASE : null) ||
      c.revision !== (service === 'realtime' ? null : CANONICAL_BASELINE_SOURCE)'''
assert old2 in s, 'container block'
new2='''      !HASH.test(c.id ?? '') ||
      !image(service, c.image) ||
      (frozenIdentity && c.imageId !== CANONICAL_BASELINE_IMAGES[service]) ||
      c.imageId !== c.image.split('@')[1] ||
      c.restarts !== 0 ||
      !timestamp(c.startedAt) ||
      c.releaseId !==
        (['api', 'web'].includes(service)
          ? frozenIdentity
            ? CANONICAL_BASELINE_RELEASE
            : value.installedReleaseId
          : null) ||
      c.revision !== (service === 'realtime' ? null : value.sourceSha)'''
s=s.replace(old2,new2,1)
p.write_text(s)
print('patched js validator')