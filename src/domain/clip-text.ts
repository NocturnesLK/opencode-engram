const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

function normalizeBody(text: string) {
  return text.trim();
}

function finalizeBoundary(text: string, end: number) {
  return Math.min(text.length, text.slice(0, end).trimEnd().length);
}

export function findLastSentenceBoundary(text: string, maxPos: number, minPos: number) {
  let lastBoundary: number | undefined;

  for (const segment of sentenceSegmenter.segment(text)) {
    const boundary = finalizeBoundary(text, segment.index + segment.segment.length);
    if (boundary < minPos) {
      continue;
    }
    if (boundary > maxPos) {
      break;
    }
    lastBoundary = boundary;
  }

  return lastBoundary;
}

export function findLastWordBreak(text: string, maxPos: number, minPos: number) {
  const boundary = text.lastIndexOf(" ", maxPos - 1);
  if (boundary < minPos) {
    return undefined;
  }
  return finalizeBoundary(text, boundary);
}

function findClipBoundary(text: string, maxPos: number, minSentencePos: number, minWordPos: number) {
  const sentenceBoundary = findLastSentenceBoundary(text, maxPos, minSentencePos);
  if (sentenceBoundary !== undefined) {
    return sentenceBoundary;
  }

  const wordBoundary = findLastWordBreak(text, maxPos, minWordPos);
  if (wordBoundary !== undefined) {
    return wordBoundary;
  }

  return maxPos;
}

/**
 * Clip text to a maximum length while preserving a truncation marker.
 */
export function clipText(text: string, size: number) {
  const body = normalizeBody(text);
  if (body.length <= size) {
    return body;
  }

  const boundary = findClipBoundary(
    body,
    size,
    Math.floor(size * 0.5),
    Math.floor(size * 0.7),
  );

  return `${body.slice(0, boundary)}\n[${body.length - boundary} chars more]`;
}

/**
 * Clip preview text to a maximum length using sentence-aware boundaries.
 */
export function clipPreviewText(text: string, maxLength: number) {
  const body = normalizeBody(text);
  if (body.length <= maxLength) {
    return body;
  }

  const boundary = findClipBoundary(
    body,
    maxLength,
    Math.floor(maxLength * 0.5),
    Math.floor(maxLength * 0.7),
  );

  return `${body.slice(0, boundary)}...`;
}
