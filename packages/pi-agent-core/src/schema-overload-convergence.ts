/** Parse TypeBox-style validation field paths from a tool-error body. */
export function extractValidationErrorFields(text: string): string[] {
  const fields = new Set<string>();
  for (const match of text.matchAll(/^\s*-\s+(\/[^\s:]+):/gm)) {
    const path = match[1];
    if (path) fields.add(path);
  }
  return [...fields].sort();
}

export function collectValidationErrorFields(texts: readonly string[]): string[] {
  const fields = new Set<string>();
  for (const text of texts) {
    for (const field of extractValidationErrorFields(text)) fields.add(field);
  }
  return [...fields].sort();
}

/** True when the current error-field set is a nonempty proper subset of the previous set. */
export function isConvergingValidationFieldSet(previous: readonly string[], current: readonly string[]): boolean {
  if (previous.length === 0 || current.length === 0) return false;
  if (current.length >= previous.length) return false;
  const prev = new Set(previous);
  return current.every((field) => prev.has(field));
}

/** True when current fields are nonempty and not a subset of previous (rotating / different missing fields). */
export function isRotatingValidationFieldSet(previous: readonly string[], current: readonly string[]): boolean {
  if (current.length === 0) return false;
  const prev = new Set(previous);
  return current.some((field) => !prev.has(field));
}

export function decideSchemaOverloadBreaker(input: {
  consecutive: number;
  cap: number;
  previousFields: readonly string[];
  currentFields: readonly string[];
  narrowedRetryGranted: boolean;
}): { trip: boolean; grantNarrowedRetry: boolean } {
  if (input.consecutive < input.cap) return { trip: false, grantNarrowedRetry: false };
  if (!input.narrowedRetryGranted) {
    if (isConvergingValidationFieldSet(input.previousFields, input.currentFields)) {
      return { trip: false, grantNarrowedRetry: true };
    }
    if (isRotatingValidationFieldSet(input.previousFields, input.currentFields)) {
      return { trip: false, grantNarrowedRetry: true };
    }
  }
  return { trip: true, grantNarrowedRetry: false };
}

export function narrowedSchemaRetryInstruction(fields: readonly string[]): string {
  const listed = fields.length > 0 ? fields.join(", ") : "the remaining invalid fields";
  return (
    `Schema validation is converging. Retry with a minimal diff: only fix ${listed}. ` +
    `Do not rewrite fields that already validated.`
  );
}
