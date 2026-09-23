# Asset extract I/O contract

Input:

- Project root.
- Episode files or episode range.
- Optional existing assets.

Output asset record fields:

- `name`
- `aliases`
- `episodes`
- `type`
- `visual_prompt` or image-generation prompt
- `image_path`
- `vision_checked`

Rule: records must preserve outfit/appearance variants as separate usable assets when the script requires them.

Important character reference fields:

- `role_class`: `lead` or `important_support` when Xiaohongshu research is required.
- `style_reference_ids`: IDs adopted from `<project>/asset_style_references.json`.
- `style_reference_status`: `pending_review`, `approved`, or `rejected`.
- Important characters cannot enter paid Jubian image generation unless status is `approved`.

`asset_style_references.json` stores role tags, queries, fixed filters, input hash, MCP version, public note ID/source URL/title/author name/publish time/interaction counts, downloaded local paths, review status/reason, and extracted visual elements. It must never store cookies, `xsec_token`, MCP session IDs, request headers, or authorization values.
