import type { Category, Finding, Severity } from './types.ts';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export type ScoredCategory = Exclude<Category, 'maintainability'>;

export const SEVERITY_WEIGHT: Record<Severity, number> = { high: 25, medium: 10, low: 3 };
export const CATEGORY_WEIGHT: Record<ScoredCategory, number> = {
  speed: 0.35,
  resources: 0.25,
  reliability: 0.25,
  security: 0.15,
};

/** Highest overall score a flow can get while it has an open high-severity security finding (C). */
export const SECURITY_CAP = 79;

export interface CategoryScore {
  score: number;
  grade: Grade;
  findings: number;
}

export interface Score {
  overall: number;
  grade: Grade;
  categories: Record<ScoredCategory, CategoryScore>;
  /** Set when an open high-severity security finding capped the grade at C. */
  capped?: boolean;
}

export function grade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

/** How much one finding takes off its category score. */
export function deduction(finding: Finding): number {
  const share = finding.evidence?.timeSharePct;
  const impact = share === undefined ? 1 : Math.min(1.5, 0.5 + share / 100);
  return SEVERITY_WEIGHT[finding.severity] * finding.confidence * impact;
}

/**
 * Each category starts at 100 and loses points per finding (see `deduction`). The overall
 * score is the weighted average of the categories; an open high-severity security finding caps
 * it at a C. Maintainability findings don't count.
 */
export function scoreFindings(
  findings: Finding[],
  isAccepted: (finding: Finding) => boolean = () => false,
): Score {
  const categories = {} as Record<ScoredCategory, CategoryScore>;
  let overall = 0;
  for (const category of Object.keys(CATEGORY_WEIGHT) as ScoredCategory[]) {
    const counted = findings.filter((f) => f.category === category && !isAccepted(f));
    const lost = counted.reduce((sum, f) => sum + deduction(f), 0);
    const score = Math.max(0, Math.round(100 - lost));
    categories[category] = { score, grade: grade(score), findings: counted.length };
    overall += score * CATEGORY_WEIGHT[category];
  }
  let rounded = Math.round(overall);
  const highSecurity = findings.some(
    (f) => f.category === 'security' && f.severity === 'high' && !isAccepted(f),
  );
  if (highSecurity && rounded > SECURITY_CAP) {
    rounded = SECURITY_CAP;
    return { overall: rounded, grade: grade(rounded), categories, capped: true };
  }
  return { overall: rounded, grade: grade(rounded), categories };
}
