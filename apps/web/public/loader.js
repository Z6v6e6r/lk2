(function padlHubLoader() {
  'use strict';

  var script = document.currentScript;
  var manifestUrl = script && script.getAttribute('data-manifest');
  var mountId = (script && script.getAttribute('data-mount-id')) || 'phub-app';
  var tenantKey = script && script.getAttribute('data-tenant-key');
  var apiBaseUrl = script && script.getAttribute('data-api-base-url');

  if (!manifestUrl || !tenantKey || !document.getElementById(mountId)) {
    console.error('PadlHub loader requires data-manifest, data-tenant-key and a mount element.');
    return;
  }

  fetch(manifestUrl, { credentials: 'omit', cache: 'no-store' })
    .then(function readManifest(response) {
      if (!response.ok) throw new Error('Manifest request failed');
      return response.json();
    })
    .then(function loadRelease(manifest) {
      window.__PHUB_BOOTSTRAP__ = Object.freeze({
        tenantKey: tenantKey,
        release: manifest.release,
        apiBaseUrl: apiBaseUrl || window.location.origin,
      });
      (manifest.styles || []).forEach(function addStylesheet(url) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.integrity = manifest.integrity && manifest.integrity[url];
        if (link.integrity) link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
      });
      var entry = document.createElement('script');
      entry.type = 'module';
      entry.src = manifest.entry;
      entry.integrity = manifest.integrity && manifest.integrity[manifest.entry];
      if (entry.integrity) entry.crossOrigin = 'anonymous';
      document.head.appendChild(entry);
    })
    .catch(function reportLoadFailure(error) {
      console.error('PadlHub bundle could not be loaded.', error);
    });
})();
