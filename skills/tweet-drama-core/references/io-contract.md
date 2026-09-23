# Core I/O contract

Inputs:

- A project root path.
- Optional episode numbers.
- Optional asset type: `character`, `scene`, or `prop`.

Outputs:

- Normalized project paths.
- Episode file inventory.
- Asset inventory with name, aliases, episodes, type, visual prompt, image path, and vision-check status where available.
- Manifest/status summaries for resume decisions.

Rule: helpers should be usable from a copied skill bundle and should not require UI modules.
