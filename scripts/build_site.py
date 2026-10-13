"""Package only the public academic website for GitHub Pages."""
import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def build(output):
    target = Path(output).resolve()
    if target == ROOT or ROOT.is_relative_to(target):
        raise ValueError('The output directory must not be the source directory or its ancestor')
    target.mkdir(parents=True, exist_ok=True)
    for filename in ('index.html', 'admin.html'):
        source = ROOT / filename
        if not source.is_file():
            raise FileNotFoundError(f'Missing public page: {filename}')
        shutil.copy2(source, target / filename)
    for dirname in ('assets', 'data'):
        source = ROOT / dirname
        if not source.is_dir():
            raise FileNotFoundError(f'Missing public directory: {dirname}')
        shutil.copytree(source, target / dirname, dirs_exist_ok=True)
    for filename in ('site.json', 'orcid.json'):
        json.loads((target / 'data' / filename).read_text(encoding='utf-8'))
    (target / '.nojekyll').write_text('', encoding='utf-8')
    if (ROOT / '404.html').exists():
        shutil.copy2(ROOT / '404.html', target / '404.html')
    print(f'Public website packaged at {target}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='_site')
    args = parser.parse_args()
    build(args.output)
