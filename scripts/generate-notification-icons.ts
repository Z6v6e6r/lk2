/**
 * Generates the Web Push notification artwork from the brand logo, so the icon can be regenerated
 * whenever the logo changes instead of being a hand-made binary nobody can reproduce.
 *
 * The icon follows the platform expectations:
 *   * `icon` is a square brand avatar (Chrome renders it in the notification, Android crops it to a
 *     circle), so the full logo lock-up is set in white on the brand gradient with even padding;
 *   * `badge` is a monochrome silhouette (Android tints it), so it keeps the racket mark alone,
 *     drawn white on transparent.
 *
 * Usage: npm run notification:icons:generate
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import sharp from 'sharp';

const repositoryRoot = resolve(import.meta.dirname, '..');
const logoSvgPath = resolve(repositoryRoot, 'apps/web/src/assets/padlhub-logo.svg');
const outputDirectory = resolve(repositoryRoot, 'apps/web/public');

// The brand gradient used across the Web client.
const BRAND_FROM = '#B17DE8';
const BRAND_TO = '#9983FB';
// Even padding keeps the lock-up clear of the circular crop some platforms apply.
const PADDING_RATIO = 0.12;

/**
 * The logo is authored in black plus a gradient so it reads on light backgrounds. On the gradient
 * avatar every glyph becomes white, which keeps the lock-up legible and avoids a purple-on-purple "X".
 */
function monochromeWhiteLogo(svg: string): string {
  return svg
    .replace(/fill="black"/gu, 'fill="#FFFFFF"')
    .replace(/fill="url\(#[^)]*\)"/gu, 'fill="#FFFFFF"');
}

function innerLogo(svg: string): string {
  return svg.replace(/^[\s\S]*?<svg[^>]*>/u, '').replace(/<\/svg>\s*$/u, '');
}

function squareComposition({
  content,
  viewBox,
  size,
}: {
  content: string;
  viewBox: string;
  size: number;
}): string {
  const [, , width, height] = viewBox.split(/\s+/u).map(Number);
  if (width === undefined || height === undefined) throw new Error(`unusable viewBox "${viewBox}"`);
  const available = size * (1 - 2 * PADDING_RATIO);
  const scale = Math.min(available / width, available / height);
  const translateX = (size - width * scale) / 2;
  const translateY = (size - height * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${BRAND_FROM}"/>
      <stop offset="1" stop-color="${BRAND_TO}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#brand)"/>
  <g transform="translate(${translateX} ${translateY}) scale(${scale})">
    <svg viewBox="${viewBox}" width="${width}" height="${height}">${content}</svg>
  </g>
</svg>`;
}

// The badge is the racket mark alone: Android renders badges as a tinted silhouette, where any text
// would be unreadable. It is the artwork element that sits to the right of the wordmark, so the badge
// follows the logo instead of being a hand-made binary.
function rightHandMark(svg: string, viewBox: string): string {
  const viewBoxX = Number(viewBox.split(/\s+/u)[0]);
  const viewBoxWidth = Number(viewBox.split(/\s+/u)[2]);
  const threshold = viewBoxX + viewBoxWidth * 0.75;
  for (const element of svg.match(/<path[^>]*>/gu) ?? []) {
    const pathData = /\sd="([^"]+)"/u.exec(element)?.[1];
    const startX = pathData
      ? Number(/^M\s*([-+]?[0-9]*\.?[0-9]+)/u.exec(pathData)?.[1])
      : Number.NaN;
    if (Number.isFinite(startX) && startX > threshold) return element;
  }
  throw new Error('padlhub-logo.svg has no right-hand mark for the badge');
}

const logoSvg = readFileSync(logoSvgPath, 'utf8');
const viewBox = /viewBox="([^"]+)"/u.exec(logoSvg)?.[1];
if (!viewBox) throw new Error('padlhub-logo.svg has no viewBox');

const lockup = monochromeWhiteLogo(innerLogo(logoSvg));

for (const size of [192, 512]) {
  const png = await sharp(Buffer.from(squareComposition({ content: lockup, viewBox, size })))
    .png({ compressionLevel: 9 })
    .toBuffer();
  const path = resolve(outputDirectory, `phub-notification-icon-${size}.png`);
  writeFileSync(path, png);
  process.stdout.write(`wrote ${path} (${png.length} bytes)\n`);
}

const badge = await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="${viewBox}">${monochromeWhiteLogo(
      rightHandMark(logoSvg, viewBox),
    )}</svg>`,
  ),
)
  .trim()
  .resize(72, 72, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();
const badgePath = resolve(outputDirectory, 'phub-notification-badge-72.png');
writeFileSync(badgePath, badge);
process.stdout.write(`wrote ${badgePath} (${badge.length} bytes)\n`);
