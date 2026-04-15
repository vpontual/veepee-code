In a file named `solution.ts`, implement a singly linked list reversal.

Export:
1. An interface or type `Node<T> = { value: T; next: Node<T> | null }`
2. A function `reverse<T>(head: Node<T> | null): Node<T> | null` that returns the new head after reversing the list.
3. A function `toArray<T>(head: Node<T> | null): T[]` that walks the list and returns the values in order.

Requirements:
- Must run in O(n) time with O(1) extra space (iterative, in-place pointer flip).
- `reverse(null)` → `null`
- Single-node list returns the same node (no change in head pointer identity required, but `toArray(reverse(head))` must match).
- Empty array roundtrip: `toArray(reverse(null))` → `[]`

Use the `write_file` tool. Export all three as named exports (`Node`, `reverse`, `toArray`).
