import { describe, it, expect } from 'vitest';
import { extractSymbols } from '../src/tools/repo-map.js';

describe('extractSymbols', () => {
  it('TypeScript: exported and top-level declarations, not locals', () => {
    const src = 'export async function run() {}\nexport class Agent {}\nexport const x = 1;\nexport interface Opts {}\nfunction helper() {\n  const local = 2;\n}\n';
    expect(extractSymbols('.ts', src)).toEqual(['run', 'Agent', 'x', 'Opts', 'helper']);
  });
  it('Python: top-level defs and classes only', () => {
    expect(extractSymbols('.py', 'def a():\n    def inner(): pass\nclass B:\n    def m(self): pass\nasync def c(): pass\n')).toEqual(['a', 'B', 'c']);
  });
  it('Go, Rust and shell', () => {
    expect(extractSymbols('.go', 'func main() {}\nfunc (s *Srv) Serve() {}\ntype Srv struct{}\n')).toEqual(['main', 'Serve', 'Srv']);
    expect(extractSymbols('.rs', 'pub fn run() {}\nstruct Cfg {}\npub(crate) enum Mode {}\n')).toEqual(['run', 'Cfg', 'Mode']);
    expect(extractSymbols('.sh', 'deploy() {\n}\nfunction build {\n}\n')).toEqual(['deploy']);
  });
  it('unknown extensions give nothing', () => {
    expect(extractSymbols('.md', '# Title')).toEqual([]);
  });
});
