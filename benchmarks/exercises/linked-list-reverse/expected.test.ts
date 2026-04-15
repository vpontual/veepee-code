import { describe, it, expect } from 'vitest';
import { reverse, toArray, type Node } from './solution.js';

function fromArray<T>(arr: T[]): Node<T> | null {
  let head: Node<T> | null = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    head = { value: arr[i], next: head };
  }
  return head;
}

describe('linked-list reverse', () => {
  it('reverses null to null', () => {
    expect(reverse(null)).toBeNull();
    expect(toArray(reverse(null))).toEqual([]);
  });
  it('reverses single node', () => {
    expect(toArray(reverse(fromArray([42])))).toEqual([42]);
  });
  it('reverses multi-node list', () => {
    expect(toArray(reverse(fromArray([1, 2, 3, 4, 5])))).toEqual([5, 4, 3, 2, 1]);
  });
  it('reverses twice returns original', () => {
    const h = fromArray(['a', 'b', 'c', 'd']);
    expect(toArray(reverse(reverse(h)))).toEqual(['a', 'b', 'c', 'd']);
  });
  it('handles large list', () => {
    const arr = Array.from({ length: 1000 }, (_, i) => i);
    const h = fromArray(arr);
    expect(toArray(reverse(h))).toEqual([...arr].reverse());
  });
});
