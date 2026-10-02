import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

// Reuse the CI opt-in: no public ports, container network or credentials; nginx stays digest-pinned.
it.skipIf(process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')(
  'serves the exact Android callback behind TLS ingress without a directory redirect',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-android-callback-'));
    const name = `phub-android-callback-${randomUUID()}`;
    const html = join(directory, 'html');
    const fallback = join(html, 'android/oauth/yandex/index.html');
    const association = readFileSync('apps/web/public/.well-known/assetlinks.json', 'utf8');
    const config = join(directory, 'default.conf');
    const dockerfile = readFileSync('apps/web/Dockerfile', 'utf8');
    const image = dockerfile.match(
      /^FROM (docker\.io\/library\/nginx:[^\s]+@sha256:[a-f0-9]{64})$/m,
    )?.[1];
    expect(image).toBeDefined();
    const docker = (args: string[]) =>
      spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
    let containerId: string | undefined;
    try {
      mkdirSync(join(html, 'android/oauth/yandex'), { recursive: true });
      mkdirSync(join(html, '.well-known'));
      writeFileSync(join(html, 'index.html'), '<html>synthetic SPA shell</html>');
      writeFileSync(join(html, '.well-known/assetlinks.json'), association);
      copyFileSync('apps/web/public/android/oauth/yandex/index.html', fallback);
      copyFileSync('apps/web/nginx.conf', config);
      const started = docker([
        'run',
        '-d',
        '--name',
        name,
        '--label',
        `fixture.owner=${name}`,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--user',
        'nginx',
        '--tmpfs',
        '/var/cache/nginx:rw,mode=1777',
        '--tmpfs',
        '/var/run:rw,mode=1777',
        '--mount',
        `type=bind,src=${config},dst=/etc/nginx/conf.d/default.conf,readonly`,
        '--mount',
        `type=bind,src=${html},dst=/usr/share/nginx/html,readonly`,
        '--entrypoint',
        'nginx',
        image!,
        '-g',
        'daemon off;',
      ]);
      expect(started.status, started.stderr).toBe(0);
      containerId = started.stdout.trim();
      expect(containerId).toMatch(/^[a-f0-9]{64}$/);
      expect(docker(['exec', containerId, 'nginx', '-t']).status).toBe(0);
      const request = (path: string, extra: string[] = []) =>
        docker([
          'exec',
          containerId!,
          'wget',
          '-S',
          '-O',
          '-',
          '--header=Host: lk2.padlhub.su',
          '--header=X-Forwarded-Proto: https',
          ...extra,
          `http://127.0.0.1:8080${path}`,
        ]);
      for (let attempt = 0; attempt < 20; attempt++) {
        if (request('/healthz').status === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const direct = request('/android/oauth/yandex?fixture=1');
      expect(direct.status, direct.stderr).toBe(0);
      expect(direct.stderr).toMatch(/HTTP\/1\.1 200/);
      expect(direct.stderr).not.toMatch(/Location:/i);
      expect(direct.stderr).toMatch(/Content-Type: text\/html/i);
      expect(direct.stderr).toMatch(/Cache-Control: no-store/i);
      expect(direct.stderr).toMatch(/Referrer-Policy: no-referrer/i);
      expect(direct.stderr).toMatch(/X-Content-Type-Options: nosniff/i);
      expect(direct.stdout).toBe(readFileSync(fallback, 'utf8'));
      const head = docker([
        'exec',
        containerId,
        'sh',
        '-c',
        "printf 'HEAD /android/oauth/yandex HTTP/1.1\\r\\nHost: lk2.padlhub.su\\r\\nX-Forwarded-Proto: https\\r\\nConnection: close\\r\\n\\r\\n' | nc 127.0.0.1 8080",
      ]);
      expect(head.status, head.stderr).toBe(0);
      expect(head.stdout).toMatch(/HTTP\/1\.1 200/);
      expect(head.stdout).not.toMatch(/Location:/i);
      expect(head.stdout.split('\r\n\r\n')[1]).toBe('');
      const slash = request('/android/oauth/yandex/');
      expect(slash.status, slash.stderr).toBe(0);
      expect(slash.stderr).not.toMatch(/Location:/i);
      expect(slash.stdout).toBe(direct.stdout);
      const post = request('/android/oauth/yandex', ['--post-data=synthetic']);
      expect(post.status).not.toBe(0);
      expect(post.stderr).toMatch(/405 Not Allowed/);
      for (const path of ['/profile', '/android/oauth/yandexx', '/android/oauth/yandex/extra']) {
        const shell = request(path);
        expect(shell.status, shell.stderr).toBe(0);
        expect(shell.stdout).toBe('<html>synthetic SPA shell</html>');
        expect(shell.stderr).not.toMatch(/Cache-Control: no-store/i);
      }
      const assetlinks = request('/.well-known/assetlinks.json');
      expect(assetlinks.status, assetlinks.stderr).toBe(0);
      expect(assetlinks.stderr).not.toMatch(/Location:/i);
      expect(assetlinks.stdout).toBe(association);
      rmSync(fallback);
      const missing = request('/android/oauth/yandex');
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toMatch(/404 Not Found/);
      expect(missing.stderr).toMatch(/Cache-Control: no-store/i);
      expect(missing.stderr).toMatch(/Referrer-Policy: no-referrer/i);
      expect(missing.stderr).not.toMatch(/Location:/i);
    } finally {
      if (containerId) {
        const removed = docker(['rm', '-f', containerId]);
        expect(removed.status, removed.stderr).toBe(0);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
