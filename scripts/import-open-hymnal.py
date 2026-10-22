# Builds src/core/catalog/open-hymnal.ts, the public-domain hymns in the shared song database,
# from the Open Hymnal Project's ABC files (https://github.com/mzealey/openhymnal).
#   git clone --depth 1 https://github.com/mzealey/openhymnal /tmp/openhymnal
#   python3 scripts/import-open-hymnal.py /tmp/openhymnal
# Only files whose copyright line says "public domain" are used, and modern words are skipped.
import glob, json, os, re, sys
from fractions import Fraction as F

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
    text = re.sub(r'\x00\s+(?=(?:\[[^\]]*\])*[A-Z])', ' — ', text)
    text = re.sub(r'\x00\s*$', ' —', text)
    text = text.replace('\x00 ', '-').replace('\x00', '-')
    return re.sub(r'\s+', ' ', text).strip()

# ----- chords from the four-part harmony -----

STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
SHARPS = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
KEY_SHARPS = {'C': 0, 'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5, 'F#': 6, 'C#': 7, 'F': -1, 'Bb': -2, 'Eb': -3, 'Ab': -4, 'Db': -5, 'Gb': -6, 'Cb': -7}
MINOR_REL = {'A': 'C', 'E': 'G', 'B': 'D', 'F#': 'A', 'C#': 'E', 'G#': 'B', 'D#': 'F#', 'D': 'F', 'G': 'Bb', 'C': 'Eb', 'F': 'Ab', 'Bb': 'Db', 'Eb': 'Gb'}

def key_sig(k):
    m = re.match(r'([A-G][#b]?)\s*(m(?:in(?:or)?)?|maj(?:or)?)?', k.strip())
    if not m: return {}, 'C', False
    tonic, mode = m.group(1), (m.group(2) or '')
    minor = mode.startswith('m') and not mode.startswith('maj')
    major_key = MINOR_REL.get(tonic, 'C') if minor else tonic
    n = KEY_SHARPS.get(major_key, 0)
    acc = {}
    if n > 0:
        for l in SHARPS[:n]: acc[l] = 1
    elif n < 0:
        for l in SHARPS[::-1][:-n]: acc[l] = -1
    return acc, tonic, minor

NOTE = re.compile(r"(\^\^|\^|__|_|=)?([A-Ga-gzxZ])([',]*)(\d*(?:/+\d*)?)")

def length(s, unit):
    if not s: return unit
    m = re.match(r'(\d*)(/*)(\d*)', s)
    num = int(m.group(1)) if m.group(1) else 1
    if m.group(2):
        den = int(m.group(3)) if m.group(3) else 2 ** len(m.group(2))
    else:
        den = 1
    return unit * F(num, den)

def parse_voice(text, unit, ksig):
    """Events (start, dur, midi or None for rest, is_tie_continuation) for one voice's music."""
    t = F(0); events = []; bar_acc = {}; tie_pending = set(); tuplet = None; marks = []
    broken = None
    i = 0
    text = re.sub(r'![^!]*!|"[^"]*"|\{[^}]*\}', ' ', text)
    while i < len(text):
        c = text[i]
        if c == '\u00a7':
            marks.append(len(events)); bar_acc = {}; i += 1; continue
        if c == '[' and re.match(r'\[[A-Za-z]:', text[i:]):
            j = text.index(']', i); field = text[i + 1:j]
            if field.startswith('L:'):
                a, b = field[2:].split('%')[0].strip().split('/'); unit = F(int(a), int(b))
            elif field.startswith('K:'):
                ksig = key_sig(field[2:].split('%')[0])[0]
            i = j + 1; continue
        if c == '|' or c == ':' or (c == '[' and i + 1 < len(text) and text[i + 1] in '123|'):
            bar_acc = {}; i += 1
            while i < len(text) and text[i] in '|:]123': i += 1
            continue
        if c == '(' and i + 1 < len(text) and text[i + 1].isdigit():
            p = int(text[i + 1]); tuplet = [F(2 if p == 3 else (3 if p == 2 else 2), p), p]; i += 2; continue
        if c == '[':  # chord
            j = text.index(']', i); inner = text[i + 1:j]; i = j + 1
            m2 = re.match(r'(\d*(?:/+\d*)?)', text[i:]); dur_s = m2.group(1); i += len(dur_s)
            notes = list(NOTE.finditer(inner))
            durs = []
            for n in notes:
                durs.append(length(n.group(4) or dur_s, unit))
            d = min(durs) if durs else unit
            if tuplet: d *= tuplet[0]; tuplet[1] -= 1; tuplet = tuplet if tuplet[1] > 0 else None
            for n in notes:
                events.append((t, d, pitch(n, ksig, bar_acc), False))
            t += d; continue
        m = NOTE.match(text, i)
        if m:
            i = m.end()
            d = length(m.group(4), unit)
            if broken:  # previous note had > or <
                d = d * broken; broken = None
            if i < len(text) and text[i] in '<>':
                k = 1
                while i + k < len(text) and text[i + k] == text[i]: k += 1
                f = F(1, 2 ** k)
                if text[i] == '>': d, broken = d * (2 - f), f
                else: d, broken = d * f, (2 - f)
                i += k
            if tuplet: d *= tuplet[0]; tuplet[1] -= 1; tuplet = tuplet if tuplet[1] > 0 else None
            tied_next = False
            j = i
            while j < len(text) and text[j] in '.': j += 1
            if j < len(text) and text[j] == '-': tied_next = True; i = j + 1
            if m.group(2) in 'zxZ':
                events.append((t, d, None, False))
            else:
                p = pitch(m, ksig, bar_acc)
                cont = p in tie_pending
                if cont and events:
                    # extend the previous note instead of starting a new one
                    for k in range(len(events) - 1, -1, -1):
                        if events[k][2] == p:
                            s, dd, pp, cc = events[k]; events[k] = (s, dd + d, pp, cc); break
                    events.append((t, F(0), p, True))
                else:
                    events.append((t, d, p, False))
                tie_pending.discard(p)
                if tied_next: tie_pending.add(p)
            t += d; continue
        i += 1
    return events, marks

def pitch(m, ksig, bar_acc):
    acc, letter, octs = m.group(1), m.group(2), m.group(3)
    base = STEP[letter.upper()] + (72 if letter.islower() else 60)
    base += 12 * octs.count("'") - 12 * octs.count(',')
    keyname = (letter.upper(), base // 12)
    if acc:
        a = {'^': 1, '^^': 2, '_': -1, '__': -2, '=': 0}[acc]; bar_acc[keyname] = a
    else:
        a = bar_acc.get(keyname, ksig.get(letter.upper(), 0))
    return base + a

TEMPLATES = [('', (0, 4, 7)), ('m', (0, 3, 7)), ('7', (0, 4, 7, 10)), ('dim', (0, 3, 6)), ('sus4', (0, 5, 7)), ('m7', (0, 3, 7, 10))]
PRIOR = {'': 0.0, 'm': -0.05, '7': -0.15, 'dim': -0.4, 'sus4': -0.45, 'm7': -0.3}

def best_chord(weights, bass_pc, key_pc, minor_key):
    total = sum(weights.values())
    if total == 0 or len([p for p, w in weights.items() if w > 0]) < 2: return None
    best = None
    for root in range(12):
        for q, iv in TEMPLATES:
            tones = {(root + x) % 12 for x in iv}
            cover = sum(w for p, w in weights.items() if p in tones) / total
            missing = sum(1 for x in iv if weights.get((root + x) % 12, 0) == 0)
            if (root + iv[1]) % 12 not in weights or weights.get((root + iv[1]) % 12, 0) == 0:
                if q not in ('',): missing += 1   # a quality without its defining third/fourth is a guess
            score = cover - 0.18 * missing + PRIOR[q]
            if bass_pc == root: score += 0.12
            # diatonic roots are likelier
            deg = (root - key_pc) % 12
            if deg in ((0, 2, 4, 5, 7, 9, 11) if not minor_key else (0, 2, 3, 5, 7, 8, 10)): score += 0.05
            if best is None or score > best[0]: best = (score, root, q)
    return best[1], best[2]

FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

def chord_name(root, q, flats):
    return (FLAT_NAMES if flats else SHARP_NAMES)[root] + q

def harmony_at(voices, start, end):
    """Duration-weighted pitch classes sounding in [start, end) and the lowest pitch."""
    w = {}; low = None
    for ev in voices:
        for s, d, p, cont in ev:
            if p is None or d == 0: continue
            a, b = max(s, start), min(s + d, end)
            if b > a:
                w[p % 12] = w.get(p % 12, 0) + float(b - a)
                if low is None or p < low: low = p
    return w, (low % 12 if low is not None else None)

def mark_line(line, notes, chord_at, state):
    """The ABC lyric line with [Chord] put before each syllable where the harmony changes."""
    pre = re.match(r'^w:(?:\s*\d+\.\s*~?)?', line).group(0)
    body, out, n, i, in_syl = line[len(pre):], [], 0, 0, False
    while i < len(body):
        c = body[i]
        if body.startswith('\\-', i):          # a literal hyphen inside the words
            out.append(body[i:i + 2]); i += 2; continue
        if c.isspace() or c in '-|':
            in_syl = False
        elif c in '_*':
            in_syl = False; n += 1           # the syllable before (or none) holds this note
        elif not in_syl:
            in_syl = True
            if n < len(notes):
                name = chord_at(notes[n])
                if name and name != state['last']:
                    out.append(f'[{name}]'); state['last'] = name
            n += 1
        out.append(c); i += 1
    return pre + ''.join(out), n - len(notes)

def chorded(text):
    """The file text with chords marked into the melody's w: lines, and how many lines miscounted notes."""
    raw = text.splitlines()
    head = {}
    for l in raw:
        m = re.match(r'^([LKM]):\s*(.*)$', l)
        if m: head.setdefault(m.group(1), m.group(2).split('%')[0].strip())
    a, b = (head.get('L') or '1/4').split('/'); unit = F(int(a), int(b))
    ksig, tonic, minor = key_sig(head.get('K', 'C'))
    flats = any(v < 0 for v in ksig.values()) or tonic in ('F',)
    key_pc = STEP[tonic[0]] + (1 if '#' in tonic else -1 if 'b' in tonic else 0)
    voices, cur_voice, wlines, k = {}, None, [], -1
    for idx, l in enumerate(raw):
        m = re.match(r'^\[V:\s*([^\]]+)\]\s*(.*)$', l)
        if m:
            cur_voice = m.group(1).strip()
            voices.setdefault(cur_voice, []).append(m.group(2).split('%')[0])
            if cur_voice == 'S1V1': k += 1
            continue
        if l.startswith('w:') and cur_voice == 'S1V1' and k >= 0: wlines.append((idx, k))
    if 'S1V1' not in voices or not wlines: return None
    parsed = {v: parse_voice('\u00a7'.join(ls) + '\u00a7', unit, dict(ksig)) for v, ls in voices.items()}
    s1, marks = parsed['S1V1']
    others = [ev for ev, _ in parsed.values()]
    bounds = [0] + marks
    beat = F(1, 4)
    def chord_at(note):
        s, d, _, _ = note
        w, bass = harmony_at(others, s, s + max(d, beat))
        ch = best_chord(w, bass, key_pc, minor)
        return chord_name(ch[0], ch[1], flats) if ch else None
    out, bad, state = list(raw), 0, {'last': None}
    for idx, k in wlines:
        evs = s1[bounds[k]:bounds[k + 1]] if k + 1 < len(bounds) else []
        # Some files give the second note of a tie its own syllable (usually * or _), most don't.
        for keep_ties in (False, True):
            state['last'] = None                  # each line starts with its chord; dedupe() thins repeats
            notes = [e for e in evs if e[2] is not None and (keep_ties or not e[3])]
            out[idx], extra = mark_line(raw[idx], notes, chord_at, state)
            if extra == 0: break
        if extra != 0: bad += 1
    return '\n'.join(out), bad


# ----- words -----
CHORD = re.compile(r'\[[^\]]*\]')
plain = lambda t: CHORD.sub('', t)

def lines(text):
    """Breaks a verse into lines: at punctuation before a capital letter, keeping lines of 4+ words."""
    if not text: return []
    parts = re.split(r'(?<=[,;:.!?])\s+(?=(?:\[[^\]]*\])*[A-Z"\'\u2018\u201c(])', text)
    out = []
    for p in parts:
        if out and len(plain(out[-1]).split()) < 4: out[-1] += ' ' + p
        else: out.append(p)
    if len(out) > 1 and len(plain(out[-1]).split()) < 4:
        last = out.pop()
        out[-1] += ' ' + last
    return [half for line in out for half in split_long(line)]

def split_long(line):
    """Splits a line of more than 70 characters at the comma or semicolon nearest its middle."""
    if len(plain(line)) <= 70: return [line]
    cuts = [m.end() for m in re.finditer(r'[,;:!?]\s', line)]
    cuts = [c for c in cuts if len(plain(line[:c]).split()) >= 3 and len(plain(line[c:]).split()) >= 3]
    if not cuts:  # no punctuation: before a capitalised word, else the space nearest the middle
        cuts = [m.start() for m in re.finditer(r'\s(?=(?:\[[^\]]*\])*[A-Z][a-z])', line) if len(plain(line[:m.start()]).split()) >= 3 and len(plain(line[m.start():]).split()) >= 3]
    if not cuts and len(plain(line)) > 90:
        cuts = [m.start() for m in re.finditer(r'\s', line)]
    if not cuts: return [line]
    c = min(cuts, key=lambda c: abs(len(plain(line[:c])) - len(plain(line)) / 2))
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
    verses, refrain = melody_words(raw)
    # The same words with chords from the harmony, used only when the words come out identical.
    chart_verses, chart_refrain = None, []
    try:
        got = chorded(txt)
    except Exception:
        got = None
    if got and got[1] == 0:          # every music line has as many syllables as notes
        cv, cr = melody_words(got[0].splitlines())
        if [[plain(l) for l in v] for v in cv] == verses and [plain(l) for l in cr] == refrain:
            chart_verses, chart_refrain = cv, cr
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
    if chart_verses is not None: chart_verses = [v for v in chart_verses if v]
    if not verses: return None
    return finish(path, title, credits, key, verses, refrain, chart_verses, chart_refrain)

def melody_words(raw):
    """Verses and refrain (lists of lines) from the first voice's w: lines."""
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
    return verses, refrain

def dedupe(section):
    """Drops a chord that repeats the one before it in the same section."""
    last = [None]
    def keep(m):
        if m.group(1) == last[0]: return ''
        last[0] = m.group(1); return m.group(0)
    return [CHORD_NAME.sub(keep, l) for l in section]
CHORD_NAME = re.compile(r'\[([A-G][^\]]*)\]')

def finish(path, title, credits, key, verses, refrain, chart_verses, chart_refrain):
    if chart_verses is not None:
        chart_verses = [dedupe(v) for v in chart_verses]; chart_refrain = dedupe(chart_refrain)
    sections, arrangement, chart = [], [], []
    for i, v in enumerate(verses):
        sections.append(f'Verse {i+1}\n' + '\n'.join(v)); arrangement.append(f'Verse {i+1}')
        if chart_verses is not None:
            # Verses printed after the music (W:) have no notes under them, so they carry no chords.
            chart.append(f'[Verse {i+1}]\n' + '\n'.join(chart_verses[i] if i < len(chart_verses) else v))
        if refrain:
            if i == 0:
                sections.append('Chorus\n' + '\n'.join(refrain))
                if chart_verses is not None: chart.append('[Chorus]\n' + '\n'.join(chart_refrain))
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
        'chordChart': f'{{title: {title}}}\n{{key: {key}}}\n\n' + '\n\n'.join(chart) if chart else None,
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
        'lyrics': s['lyrics'], **({'chordChart': s['chordChart']} if s.get('chordChart') else {}), 'arrangement': s['arrangement'], 'source': 'Open Hymnal Project',
    })
out = open(dest, 'w', encoding='utf-8')
out.write('// Generated from the Open Hymnal Project (openhymnal.org), public-domain hymns only, by\n')
out.write('// scripts/import-open-hymnal.py. Do not edit by hand; re-run the script instead.\n')
out.write("import type { CatalogSong } from '../types.js';\n\n")
out.write('export const OPEN_HYMNAL: CatalogSong[] = ')
out.write(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
out.write(';\n')
print(f'{len(rows)} hymns written to {dest} ({skipped} files skipped: not public domain or no words)')
