# Script split I/O contract

Input:

- Source script path.
- Project root.

Output:

- `episodes/<episode>.txt` or the current project naming convention.
- Split report: episode count, source length, retained length, warnings.

Acceptance:

- No meaningful script text is silently dropped.
- Existing episode files are overwritten only when the user requested regeneration.
