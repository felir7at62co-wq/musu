"""Read the project video bans written by the native tool; never write bans."""
import hashlib
from datetime import datetime
import json
from pathlib import Path
import re


def read_bans(project: Path) -> dict:
    path = Path(project) / 'video-bans.json'
    try:
        text = path.read_text(encoding='utf-8-sig')
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise ValueError(f'{path}: cannot read video ban list ({error}); repair before continuing') from error
    try:
        data = json.loads(text)
        if not isinstance(data, dict) or type(data.get('version')) is not int or data['version'] != 1 or not isinstance(data.get('videos'), list):
            raise ValueError('expected version 1 and videos array')
        result = {}
        for row in data['videos']:
            if not isinstance(row, dict) or not isinstance(row.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', row['sha256']) \
                    or not isinstance(row.get('labels'), list) or not row['labels'] \
                    or any(not isinstance(label, str) or not label.strip() for label in row['labels']) \
                    or type(row.get('banned')) is not bool or not isinstance(row.get('reason'), str) \
                    or not isinstance(row.get('updated_at'), str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', row['updated_at']) \
                    or not isinstance(row.get('video'), str) or not Path(row['video']).is_absolute() \
                    or row['sha256'] in result:
                raise ValueError('invalid or duplicate video ban row')
            datetime.fromisoformat(row['updated_at'])
            result[row['sha256']] = row
        return result
    except (OSError, ValueError, TypeError) as error:
        raise ValueError(f'{path}: invalid video ban list ({error}); repair before continuing') from error


def check_videos(project: Path, videos) -> dict:
    """Hash actual bytes, reject active bans, and return path-to-hash cache identities."""
    bans = read_bans(project)
    hashes = {}
    for video in videos:
        path = Path(video).resolve()
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        hashes[str(path)] = digest
        row = bans.get(digest)
        if row and row['banned']:
            raise ValueError(f"Video banned: {path}; sha256={digest}; labels={', '.join(row['labels'])}; reason={row['reason']}. Replace this version or unban an incorrect label; not an approval.")
    return hashes


def find_project(path: Path, project=None) -> Path:
    """Require an explicit project or a project_config.json ancestor for video drafts."""
    if project:
        root = Path(project).resolve()
        if not root.is_dir():
            raise ValueError(f'Project directory missing: {root}')
        return root
    path = Path(path).resolve()
    for root in (path, *path.parents):
        if (root / 'project_config.json').is_file():
            return root
    raise ValueError('Video draft requires explicit project or a project_config.json ancestor to check video bans')
