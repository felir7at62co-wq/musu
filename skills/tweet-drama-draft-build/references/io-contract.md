# Draft build I/O contract

Input:

- Ordered reviewed Jubian videos with subtitle_cleanup=clean or not_required; pending requires explicit draft=True and an unfinished-preview label.
- Shot/task source mapping, original spoken text, speech_type and speaker identity: dialogue, vo, os, 心声, 旁白 and 解说 are retained when actually voiced. Actions and unvoiced descriptions are not subtitles.
- Complete actual_speech_start/end audio evidence for every final spoken cue. Only explicit drafts may use marked 9-effective-characters-per-second estimates.
- Project root and an approved per-episode BGM mix containing at least two emotion-matched tracks; keep the segment selection and listening record with the project.

Output:

- Editable draft, ordered media manifest, SRT, preview MP4 and warnings.
- Subtitle cues only for actual spoken content, preserving original text and speaker.
- No transitions or effects unless the project style explicitly requires them.

Generation duration and resolution follow the current selected model and project, not fixed historical shot limits. Export dimensions are separate from source resolution and paid enhancement. See the two skills' SKILL.md files for review requirements and delivery styling.
