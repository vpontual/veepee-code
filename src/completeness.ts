/**
 * Incomplete-extension detection.
 *
 * The commonest way an otherwise-correct change is wrong: you add a member to
 * an enumerated set in one place and miss the other places that enumerate the
 * same set. A new enum case and the switch in another module. A new operation
 * and the validator. A new provider and the registry array. The code compiles,
 * the existing tests pass — nothing exercises the new member's missing half —
 * and the bug ships.
 *
 * The harness eval caught vcode doing exactly this, reproducibly: told to add a
 * `rename` operation "following the conventions already used", the agent added
 * the SQL branch and the registry entry in one file and never touched the
 * validator in the other. Tests passed, because the visible tests did not cover
 * the new operation. Only the grader noticed.
 *
 * ## The check
 *
 * Find *enumeration sites* — a switch's case labels, an array of string
 * literals — and compare their members across files. If one site is a strict
 * superset of another and they overlap substantially, the smaller one is a
 * candidate for the same edit.
 *
 * This is deliberately a nudge and never an edit. The heuristic is good, not
 * sound: a file may legitimately enumerate a subset, so the model is asked to
 * check rather than told it is wrong. It fires at most once per turn.
 *
 * It is also deliberately generic. Tuning the harness to pass one eval task
 * would make the eval worthless; this fires on any project where two files
 * enumerate the same family of literals and one has fallen behind.
 */

/** Quoted string literals appearing as switch-case labels. */
const CASE_LABEL = /\bcase\s+['"`]([^'"`]+)['"`]\s*:/g;
/** Arrays consisting only of string literals, e.g. `= ['a', 'b'] as const`. */
const LITERAL_ARRAY = /\[\s*((?:['"`][^'"`]+['"`]\s*,\s*)+['"`][^'"`]+['"`])\s*,?\s*\]/g;
/** Members of a string-literal union: `type X = 'a' | 'b'`. */
const LITERAL_UNION = /=\s*((?:['"`][^'"`]+['"`]\s*\|\s*)+['"`][^'"`]+['"`])/g;

/** A set of literals enumerated together somewhere in a file. */
export interface EnumerationSite {
  file: string;
  members: Set<string>;
}

export interface ExtensionGap {
  /** The file that looks behind. */
  file: string;
  /** Members it has in common with the fuller site. */
  shared: string[];
  /** Members the fuller site has that this one does not. */
  missing: string[];
  /** Where the fuller enumeration lives. */
  fullerFile: string;
}

/** Overlap below this is coincidence, not the same family. */
const MIN_SHARED = 2;
/** Above this, the "gap" is more likely two unrelated lists. */
const MAX_MISSING = 3;

export function enumerationSites(file: string, content: string): EnumerationSite[] {
  const sites: EnumerationSite[] = [];

  const caseLabels = new Set<string>();
  for (const m of content.matchAll(CASE_LABEL)) caseLabels.add(m[1]);
  if (caseLabels.size >= MIN_SHARED) sites.push({ file, members: caseLabels });

  for (const re of [LITERAL_ARRAY, LITERAL_UNION]) {
    for (const m of content.matchAll(re)) {
      const members = new Set(
        m[1].split(/[,|]/).map((s) => s.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean),
      );
      if (members.size >= MIN_SHARED) sites.push({ file, members });
    }
  }
  return sites;
}

/**
 * Compare enumeration sites across files and report the ones that look behind.
 *
 * Only sites in *different* files are compared: one file legitimately holding
 * both a full list and a partial one (a switch handling a subset, say) is
 * normal and not worth interrupting for.
 */
export function findExtensionGaps(files: Map<string, string>): ExtensionGap[] {
  const sites: EnumerationSite[] = [];
  for (const [file, content] of files) sites.push(...enumerationSites(file, content));

  const gaps = new Map<string, ExtensionGap>();
  for (const bigger of sites) {
    for (const smaller of sites) {
      if (bigger.file === smaller.file) continue;
      const shared = [...smaller.members].filter((m) => bigger.members.has(m));
      const missing = [...bigger.members].filter((m) => !smaller.members.has(m));
      if (shared.length < MIN_SHARED) continue;
      if (missing.length === 0 || missing.length > MAX_MISSING) continue;
      // Keep the most complete report per file rather than one per pairing.
      const existing = gaps.get(smaller.file);
      if (existing && existing.missing.length >= missing.length) continue;
      gaps.set(smaller.file, {
        file: smaller.file,
        shared: shared.sort(),
        missing: missing.sort(),
        fullerFile: bigger.file,
      });
    }
  }
  return [...gaps.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** The nudge text, or null when nothing looks incomplete. */
export function buildCompletenessNudge(gaps: ExtensionGap[]): string | null {
  if (gaps.length === 0) return null;
  const lines = [
    'Before you finish: some files look like they enumerate the same things and have fallen out of step.',
    '',
  ];
  for (const g of gaps.slice(0, 4)) {
    lines.push(
      `- ${g.file} lists ${g.shared.map((s) => `"${s}"`).join(', ')} but not ` +
      `${g.missing.map((s) => `"${s}"`).join(', ')}, which ${g.fullerFile} has.`,
    );
  }
  lines.push(
    '',
    'If those files should handle the new case too — a validator, a type union, a',
    'registry, a docs table — update them now. If they are meant to differ, say so',
    'and finish. Do not assume a passing test suite proves this: the existing tests',
    'do not cover code you just added.',
  );
  return lines.join('\n');
}

/**
 * Which gaps are worth nudging about, given what the model just edited.
 *
 * The original rule excluded any file the model had touched — "if it edited the
 * file and left it as-is, that was a decision, not an oversight." That reasoning
 * does not survive contact with the failure it was written for. Told to add a
 * `rename` operation, the model edits `operations.ts` to add the interface and
 * the union member, forgets the `case 'rename':` in the validator two functions
 * below, and edits `render.ts` correctly. The file IS edited, the extension IS
 * half done, and the exclusion threw away the one gap that mattered. Measured:
 * that task fails roughly three runs in ten, every time on the missing
 * validator branch, with the detector able to see it perfectly.
 *
 * An edited file that already MENTIONS the new member elsewhere is in fact the
 * strongest signal available — the model has committed to the extension and
 * stopped halfway. That case is reported first.
 *
 * A file the model never touched and which never mentions the member is the
 * weakest case and stays reportable, because that is the original scenario, but
 * it sorts last.
 */
export function selectGaps(
  gaps: ExtensionGap[],
  editedFiles: Set<string>,
  contents: Map<string, string>,
): ExtensionGap[] {
  // MEASURED, AND THE MEASUREMENT WON.
  //
  // The argument below for including edited files is a good one, and it is
  // wrong. A/B on one binary, 10 runs per arm, `extend-existing-pattern`:
  //
  //   including edited files   7/10   (59s avg, 17 tool calls)
  //   excluding them          10/10   (48s avg, 15 tool calls)
  //
  // Not significant on its own (Fisher p≈0.21) but the direction is against the
  // change and the cost is visible in the trajectory: the extra nudge fires,
  // adds a turn, and the model goes and does something with it. So the original
  // exclusion stays the default and the "improvement" is the opt-in, which is
  // the opposite of what I expected when I wrote it.
  if (process.env.VCODE_COMPLETENESS_INCLUDE_EDITED !== '1') {
    return gaps.filter((g) => !editedFiles.has(g.file));
  }
  const strength = (g: ExtensionGap): number => {
    const text = contents.get(g.file) ?? '';
    const mentionsMissing = g.missing.some((m) => text.includes(m));
    if (editedFiles.has(g.file) && mentionsMissing) return 0; // half-finished, in a file just touched
    if (mentionsMissing) return 1;
    if (editedFiles.has(g.file)) return 2;
    return 3;
  };
  return [...gaps].sort((a, b) => strength(a) - strength(b));
}
