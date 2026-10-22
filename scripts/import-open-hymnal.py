# Builds src/core/catalog/open-hymnal.ts, the public-domain hymns in the shared song database,
# from the Open Hymnal Project's ABC files (https://github.com/mzealey/openhymnal).
#   git clone --depth 1 https://github.com/mzealey/openhymnal /tmp/openhymnal
#   python3 scripts/import-open-hymnal.py /tmp/openhymnal
# Only files whose copyright line says "public domain" are used, and modern words are skipped.
import glob, json, os, re, sys

src = sys.argv[1]
dest = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'catalog', 'open-hymnal.ts')

def syllables(line):
    line = re.sub(r'^\s*\d+\.\s*~?', '', line)          # verse number
    line = line.replace('\\-', '\x00')
    toks = []
    for t in re.split(r'\s+', line.strip()):
        if t in ('', '_', '*', '|') : continue
        toks.append(t)
    word, words = '', []
    for t in toks:
        t = t.replace('_', '').replace('*', '').replace('|', '')
        if not t: continue
        if t.endswith('-') and not t.endswith('\x00'):
            word += t[:-1]
            continue
        # split hyphen-joined syllables inside a token, e.g. "a-bide"
        parts = t.split('-')
        word += ''.join(parts)
        words.append(word); word = ''
    if word: words.append(word)
    text = ' '.join(words).replace('~', ' ')
    text = re.sub(r'\x00\s+(?=[A-Z])', ' — ', text)
    text = re.sub(r'\x00\s*$', ' —', text)
    text = text.replace('\x00 ', '-').replace('\x00', '-')
    return re.sub(r'\s+', ' ', text).strip()

def lines(text):
    """Breaks a verse into lines: at punctuation before a capital letter, keeping lines of 4+ words."""
    if not text: return []
    parts = re.split(r'(?<=[,;:.!?])\s+(?=[A-Z"\'\u2018\u201c(])', text)
    out = []
    for p in parts:
        if out and len(out[-1].split()) < 4: out[-1] += ' ' + p
        else: out.append(p)
    if len(out) > 1 and len(out[-1].split()) < 4:
        last = out.pop()
        out[-1] += ' ' + last
    return [half for line in out for half in split_long(line)]

def split_long(line):
    """Splits a line of more than 70 characters at the comma or semicolon nearest its middle."""
    if len(line) <= 70: return [line]
    cuts = [m.end() for m in re.finditer(r'[,;:!?]\s', line)]
    cuts = [c for c in cuts if len(line[:c].split()) >= 3 and len(line[c:].split()) >= 3]
    if not cuts:  # no punctuation: before a capitalised word, else the space nearest the middle
        cuts = [m.start() for m in re.finditer(r'\s(?=[A-Z][a-z])', line) if len(line[:m.start()].split()) >= 3 and len(line[m.start():].split()) >= 3]
    if not cuts and len(line) > 90:
        cuts = [m.start() for m in re.finditer(r'\s', line)]
    if not cuts: return [line]
    c = min(cuts, key=lambda c: abs(c - len(line) / 2))
    return split_long(line[:c].strip()) + split_long(line[c:].strip())

def parse(path):
    b = open(path, 'rb').read()
    try: txt = b.decode('utf-8')
    except UnicodeDecodeError: txt = b.decode('latin-1')
    raw = txt.replace('`', "'").splitlines()
    head = {}
    for l in raw:
        m = re.match(r'^([TCSK]):\s*(.*)$', l)
        if m: head.setdefault(m.group(1), []).append(m.group(2).split('%')[0].strip())
    copyright = ' '.join(c for c in head.get('C', []) if c.lower().startswith('copyright'))
    if not copyright.lower().startswith('copyright: public domain'): return None
    if 'words: copyright' in copyright.lower(): return None
    title = head['T'][0]
    credits = ' '.join(c for c in head.get('C', []) if not c.lower().startswith('copyright'))
    key = (head.get('K') or ['C'])[-1].split()[0] if head.get('K') else 'C'
    # first voice w: blocks
    blocks, cur, voice = [], [], None
    for l in raw:
        v = re.match(r'^\[?V:\s*(\S+?)\]?\s', l + ' ')
        if v: voice = v.group(1).rstrip(']')
        if l.startswith('w:'):
            if voice in (None, 'S1V1', '1'): cur.append(l[2:])
        else:
            if cur and not l.startswith('+:'): blocks.append(cur); cur = []
    if cur: blocks.append(cur)
    nverses = max((len(b) for b in blocks), default=0)
    # Raw w: text per verse across all blocks, so a word split over two music lines joins up.
    raw_verses = [[] for _ in range(nverses)]
    refrain = []
    last_multi = max((i for i, b in enumerate(blocks) if len(b) > 1), default=-1)
    for bi, b in enumerate(blocks):
        if len(b) == 1 and nverses > 1:
            if bi > last_multi: refrain.append(b[0])          # a chorus after the verses
            else:
                for v in raw_verses: v.append(b[0])             # a line every verse sings
            continue
        for i, line in enumerate(b):
            raw_verses[i].append(re.sub(r'^\s*\d+\.\s*~?', '', line) if raw_verses[i] else line)
    verses = [lines(syllables(' '.join(v))) for v in raw_verses]
    refrain = lines(syllables(' '.join(refrain))) if refrain else []
    # extra verses as plain text (W:)
    extra, cur = [], []
    for l in raw:
        if l.startswith('W:'):
            t = l[2:].strip()
            if not t:
                if cur: extra.append(cur); cur = []
            else:
                cur.append(re.sub(r'^\d+\.\s*', '', t).replace('\\-', '-'))
    if cur: extra.append(cur)
    verses = [v for v in verses if v] + extra
    if not verses: return None
    sections, arrangement = [], []
    for i, v in enumerate(verses):
        sections.append(f'Verse {i+1}\n' + '\n'.join(v)); arrangement.append(f'Verse {i+1}')
        if refrain:
            if i == 0: sections.append('Chorus\n' + '\n'.join(refrain))
            arrangement.append('Chorus')
    yr = re.findall(r'\b(1[0-9]{3})\b', credits)
    def clean(x):
        x = re.sub(r"\s+", " ", x).strip(" .,")
        x = re.sub(r",?\s*(?:circa|c\.)?\s*1[0-9]{3}(?:-1[0-9]{3})?$", "", x).strip(" .,")
        return x
    words = ''
    m = re.search(r"Words:\s*(.*?)(?=\s+Music[A-Za-z ]*:|\s+Setting:|$)", credits)
    if m: words = clean(m.group(1))
    music = ''
    m = re.search(r"Music[A-Za-z ]*:\s*(.*?)(?=\s+Setting:|$)", credits)
    if m:
        x = re.sub(r"(?:\bor\s+)?'[^']*'\s*", "", m.group(1))
        music = clean(x)
    tune = re.search(r"Music[A-Za-z ]*:\s*'([^']+)'", credits)
    writers = words or 'Traditional'
    slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
    return {
        'id': 'oh-' + slug,
        'title': title, 'writers': writers, 'music': music or None, 'year': int(yr[0]) if yr else None,
        'tune': tune.group(1).upper() if tune else None, 'defaultKey': key.replace('maj', '') if key else 'C',
        'lyrics': '\n\n'.join(sections), 'arrangement': arrangement, 'source': os.path.basename(path),
    }

songs, skipped = [], 0
for p in sorted(glob.glob(os.path.join(src, 'Complete', '*', '*.abc'))):
    try:
        s = parse(p)
    except Exception as e:
        s = None
    if s: songs.append(s)
    else: skipped += 1
# keep one setting per title (first tune)
seen, uniq = set(), []
for s in songs:
    k = s['title'].lower()
    if k in seen: continue
    seen.add(k); uniq.append(s)
d = uniq

SEASONS = [('Christmas', r'christmas|noel|bethlehem|manger|angels from|herald angels|silent night|joy to the world|o come, all ye|first noel|midwinter|wise men|child|shepherds|good christian men|it came upon'),
           ('Easter', r'risen|arose|easter|resurrection|alive|triumphant|christ the lord is risen'),
           ('Lent', r'cross|calvary|wounded|sacred head|lamb goes|passion|thorns|survey|bleed'),
           ('Advent', r'advent|come, thou long|o come, o come|watchman|comfort, comfort|prepare'),
           ('Pentecost', r'holy ghost|holy spirit|spirit of god|come, holy'),
           ('Evening', r'evening|night|abide with me|day is dying|sun is'),
           ('Communion', r'supper|bread|table|communion|feast'),
           ('Trinity', r'trinity|three in one|holy, holy, holy')]
rows = []
for s in d:
    themes = [n for n, rx in SEASONS if re.search(rx, s['title'].lower())]
    rows.append({
        'id': s['id'], 'title': s['title'], 'language': 'en', 'writers': s['writers'], **({'music': s['music']} if s.get('music') else {}),
        **({'year': s['year']} if s.get('year') else {}), 'rights': 'public-domain', 'copyright': 'Public domain',
        'defaultKey': s['defaultKey'], 'bpm': None, **({'tune': s['tune']} if s.get('tune') else {}), 'themes': ['Hymn'] + themes,
        'lyrics': s['lyrics'], 'arrangement': s['arrangement'], 'source': 'Open Hymnal Project',
    })
out = open(dest, 'w', encoding='utf-8')
out.write('// Generated from the Open Hymnal Project (openhymnal.org), public-domain hymns only, by\n')
out.write('// scripts/import-open-hymnal.py. Do not edit by hand; re-run the script instead.\n')
out.write("import type { CatalogSong } from '../types.js';\n\n")
out.write('export const OPEN_HYMNAL: CatalogSong[] = ')
out.write(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
out.write(';\n')
print(f'{len(rows)} hymns written to {dest} ({skipped} files skipped: not public domain or no words)')
