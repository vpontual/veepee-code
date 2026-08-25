import { describe, expect, it } from 'vitest';
import { parseSelectedColumns, findMissingReads } from '../src/lint/select-columns.js';
import { scanSource } from '../src/lint/scan.js';

function assertSet(result: Set<string> | 'star' | null): asserts result is Set<string> {
  if (result === null || result === 'star') throw new Error('expected a Set');
}

describe('parseSelectedColumns', () => {
  it('exposes {app_id, name} from SELECT g.app_id, g.name FROM games g', () => {
    const result = parseSelectedColumns('SELECT g.app_id, g.name FROM games g');
    assertSet(result);
    expect(result.has('app_id')).toBe(true);
    expect(result.has('name')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('exposes {c} from SELECT COUNT(*) AS c FROM x', () => {
    const result = parseSelectedColumns('SELECT COUNT(*) AS c FROM x');
    assertSet(result);
    expect(result.has('c')).toBe(true);
    expect(result.size).toBe(1);
  });

  it("returns 'star' for SELECT * FROM x", () => {
    expect(parseSelectedColumns('SELECT * FROM x')).toBe('star');
  });

  it('parses multi-line query with JOIN and qualified names', () => {
    const sql = `
      SELECT g.app_id, g.name, p.title
      FROM games g
      INNER JOIN providers p ON g.provider_id = p.id
      WHERE g.active = 1
    `;
    const result = parseSelectedColumns(sql);
    assertSet(result);
    expect(result.has('app_id')).toBe(true);
    expect(result.has('name')).toBe(true);
    expect(result.has('title')).toBe(true);
    expect(result.size).toBe(3);
  });

  it('subquery in column list does not leak its own columns', () => {
    const sql = `
      SELECT g.app_id,
             (SELECT MAX(created_at) FROM events e WHERE e.game_id = g.app_id) AS last_seen
      FROM games g
    `;
    const result = parseSelectedColumns(sql);
    assertSet(result);
    expect(result.has('app_id')).toBe(true);
    expect(result.has('last_seen')).toBe(true);
    // Subquery columns must NOT leak into the outer set.
    expect(result.has('created_at')).toBe(false);
    expect(result.has('game_id')).toBe(false);
    expect(result.size).toBe(2);
  });

  it('catches the three real defects by name', () => {
    // Defect 1: getPlayedGames omitted app_id — self-exclusion filter compared a missing column.
    const selected1 = parseSelectedColumns(
      'SELECT game_id, name, category FROM games WHERE active = 1',
    );
    assertSet(selected1);
    const reads1 = new Set(['game_id', 'name', 'category', 'app_id']);
    expect(findMissingReads(selected1, reads1)).toEqual(['app_id']);

    // Defect 2: getAllGames omitted provider_id — cards drew wrong data.
    const selected2 = parseSelectedColumns(
      'SELECT id, title, description FROM games',
    );
    assertSet(selected2);
    const reads2 = new Set(['id', 'title', 'description', 'provider_id']);
    expect(findMissingReads(selected2, reads2)).toEqual(['provider_id']);

    // Defect 3: sync.mjs read providerId where interface never defined it.
    const selected3 = parseSelectedColumns(
      'SELECT id, name, url FROM providers',
    );
    assertSet(selected3);
    const reads3 = new Set(['id', 'name', 'url', 'providerId']);
    expect(findMissingReads(selected3, reads3)).toEqual(['providerId']);
  });

  it('a CORRECT query reading only what it selects produces NO finding', () => {
    const selected = parseSelectedColumns(
      'SELECT g.app_id, g.name, g.category FROM games g WHERE g.active = 1',
    );
    assertSet(selected);
    // All reads are covered by the SELECT list.
    const reads = new Set(['app_id', 'name', 'category']);
    expect(findMissingReads(selected, reads)).toEqual([]);
  });

  it('scanSource reports nothing when the read cannot be confidently tied to a query', () => {
    // No db.prepare call at all — should return empty.
    const code1 = `
      function foo() {
        const result = someOtherQuery();
        return result.foo;
      }
    `;
    expect(scanSource(code1)).toEqual([]);

    // Variable reference (not a literal) — should skip.
    const code2 = `
      function bar() {
        const sql = "SELECT id FROM x";
        const result = db.prepare(sql).get();
        return result.foo;
      }
    `;
    expect(scanSource(code2)).toEqual([]);
  });
});