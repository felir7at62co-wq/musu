# Asset vision check I/O contract

Input:

- Asset records with image paths.
- Project root.

Output:

- Updated asset records where `visual_prompt` follows the actual image.
- `vision_checked=true` when inspected.
- Warnings for mismatched image/name/type.

Rule: if a user uploaded a replacement image, regenerate the prompt from the replacement image instead of reusing the previous prompt.
