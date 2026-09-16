// The recommendation card fills its box with `object-fit: cover`. A creative that is smaller than the
// box, or whose aspect is incompatible with it, would then be enlarged and cropped, hiding the text
// the CUP prints on it. Such a creative is shown whole on the card background instead. This removes
// the crop and the enlargement the layout adds; it cannot restore detail the source file lacks.
const IMAGE_ENLARGEMENT_TOLERANCE = 1.01;
const IMAGE_ASPECT_DEVIATION_LIMIT = 2.5;

export function recommendationAdImageFit(input: {
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
}): 'cover' | 'contain' {
  const { naturalWidth, naturalHeight, renderedWidth, renderedHeight } = input;
  if (naturalWidth <= 0 || naturalHeight <= 0 || renderedWidth <= 0 || renderedHeight <= 0) {
    return 'cover';
  }
  const coverScale = Math.max(renderedWidth / naturalWidth, renderedHeight / naturalHeight);
  const sourceAspect = naturalWidth / naturalHeight;
  const boxAspect = renderedWidth / renderedHeight;
  const aspectDeviation = Math.max(sourceAspect / boxAspect, boxAspect / sourceAspect);
  return coverScale > IMAGE_ENLARGEMENT_TOLERANCE || aspectDeviation >= IMAGE_ASPECT_DEVIATION_LIMIT
    ? 'contain'
    : 'cover';
}
