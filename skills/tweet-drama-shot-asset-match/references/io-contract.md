# Shot asset match I/O contract

Input:

- Episode number.
- Shot script.
- Asset inventory.

Output:

- Matched JSON manifest per episode.

Acceptance:

- All characters/scenes/props used by a shot either resolve to a concrete asset or are explicitly marked as text-only/missing.
- No cross-type match, such as a character matched to a scene.
