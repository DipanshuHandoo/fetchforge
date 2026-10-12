import type { ValidationIssue } from './errors.ts';
import type { SchemaLike } from './types.ts';
import { errorMessage } from './utils.ts';

export type SchemaOutcome = { ok: true; value: unknown } | { ok: false; issues: ValidationIssue[] };

function toIssues(error: unknown): ValidationIssue[] {
  const issues = (error as { issues?: unknown })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((issue) => ({
      message: String((issue as { message?: unknown })?.message ?? issue),
      ...((issue as { path?: unknown })?.path
        ? { path: (issue as { path: ValidationIssue['path'] }).path }
        : {}),
    }));
  }
  return [{ message: errorMessage(error) }];
}

/** Runs Standard Schema first, then `safeParse`, `parse`, or a plain validator function. */
export async function runSchema(schema: SchemaLike, value: unknown): Promise<SchemaOutcome> {
  const standard = (schema as { '~standard'?: { validate?: unknown } })['~standard'];
  if (standard && typeof standard.validate === 'function') {
    const outcome = (await standard.validate(value)) as { value?: unknown; issues?: unknown };
    if (outcome.issues) return { ok: false, issues: toIssues(outcome) };
    return { ok: true, value: outcome.value };
  }
  try {
    if (typeof (schema as { safeParse?: unknown }).safeParse === 'function') {
      const outcome = (await (schema as { safeParse: (v: unknown) => unknown }).safeParse(value)) as {
        success?: boolean;
        data?: unknown;
        error?: unknown;
      };
      if (outcome?.success) return { ok: true, value: outcome.data };
      return { ok: false, issues: toIssues(outcome?.error) };
    }
    if (typeof (schema as { parse?: unknown }).parse === 'function') {
      return { ok: true, value: await (schema as { parse: (v: unknown) => unknown }).parse(value) };
    }
    return { ok: true, value: await (schema as (v: unknown) => unknown)(value) };
  } catch (error) {
    return { ok: false, issues: toIssues(error) };
  }
}

export function describeIssues(issues: ReadonlyArray<ValidationIssue>): string {
  const format = (issue: ValidationIssue) => {
    const path = issue.path
      ?.map((part) => String(typeof part === 'object' && part !== null ? part.key : part))
      .join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  };
  const shown = issues.slice(0, 3).map(format).join('; ');
  return issues.length > 3 ? `${shown} (+${issues.length - 3} more)` : shown;
}

export function isSchemaLike(value: unknown): value is SchemaLike {
  if (typeof value === 'function') return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof (candidate['~standard'] as { validate?: unknown } | undefined)?.validate === 'function' ||
    typeof candidate.safeParse === 'function' ||
    typeof candidate.parse === 'function'
  );
}
