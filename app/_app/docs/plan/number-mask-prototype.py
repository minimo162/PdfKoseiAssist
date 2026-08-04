import re, random
from decimal import Decimal
NUM=r"\d{1,3}(?:,\d{3})*(?:\.\d+)?"
SC={"thousand":3,"million":6,"billion":9,"trillion":12}
D=lambda x: Decimal(str(x).replace(",",""))
# --- 許可リスト（マスクしないもの）: 年・年月範囲・柱・ページ番号 ---
KEEP_YEAR=re.compile(r"^(19|20)\d\d$")
RANGE=re.compile(r"\(\s*\d{2}\.\d\s*[～~ｰ\-­]\s*\d{2}\.\d\s*\)")
# --- 数値トークンの切り出し（span 付き） ---
JA_TOK=re.compile(r"([△▲])?\s*(?:(%s)\s*兆)?\s*(?:(%s)\s*億)?\s*(?:(%s)\s*百万)?\s*(?:(%s)\s*万)?\s*(?:(%s)\s*千)?\s*(%s)?"%((NUM,)*6))
EN_NEG=re.compile(r"\(\s*(%s)\s*\)\s*(thousands?|millions?|billions?|trillions?)?"%NUM, re.I)
EN_POS=re.compile(r"(?<![\d(\-­.])(%s)\s*(thousands?|millions?|billions?|trillions?)?"%NUM, re.I)

def tokens(text, lang):
    """(start, end, 実量Decimal) を返す。許可リストのものは含めない。"""
    skip=[(m.start(),m.end()) for m in RANGE.finditer(text)]
    inskip=lambda i: any(a<=i<b for a,b in skip)
    out=[]
    if lang=="ja":
        i=0
        while i<len(text):
            m=JA_TOK.match(text,i)
            if not m or not any(m.groups()[1:]) or m.end()<=i: i+=1; continue
            if inskip(m.start()): i=m.end(); continue
            tot=Decimal(0)
            for g,ex in zip(m.groups()[1:6],(12,8,6,4,3)):
                if g: tot+=D(g)*(Decimal(10)**ex)
            if m.group(7): tot+=D(m.group(7))
            if not (m.group(1) is None and KEEP_YEAR.match(str(tot))):
                out.append((m.start(1) if m.group(1) else m.start(2) if m.group(2) else m.start(),
                            m.end(), -tot if m.group(1) else tot))
            i=m.end()
    else:
        spans=[]
        for m in EN_NEG.finditer(text):
            if inskip(m.start()): continue
            v=-D(m.group(1))*(Decimal(10)**SC.get((m.group(2) or "").lower().rstrip("s"),0))
            out.append((m.start(),m.end(),v)); spans.append((m.start(),m.end()))
        for m in EN_POS.finditer(text):
            if inskip(m.start()) or any(a<=m.start()<b for a,b in spans): continue
            v=D(m.group(1))*(Decimal(10)**SC.get((m.group(2) or "").lower().rstrip("s"),0))
            if KEEP_YEAR.match(str(v)): continue
            out.append((m.start(),m.end(),v))
    out=[t for t in out if text[t[0]:t[1]].strip()]
    return sorted(out)

class Masker:
    """ジョブ単位。実量 → ID を1つの辞書で日英ともに共有する。"""
    def __init__(self, seed=0):
        self.by_mag={}; self.by_id={}
        self._rng=random.Random(seed)
        self._pool=None
    def _new_id(self):
        if self._pool is None:
            L="ABCDEFGHJKLMNPQRSTUVWXYZ"          # I/O は除く
            self._pool=[a+b+c for a in L for b in L for c in L]
            self._rng.shuffle(self._pool)          # 出現順に振らない
        return "⟦#%s⟧"%self._pool.pop()
    def sym(self, mag):
        # ⚠️ str(Decimal) は指数表記になり得るので鍵に使えない。
        #    1285.7×10^9 は Decimal('1285700000000.0')、1兆+2,857億は Decimal('1285700000000')
        #    で、数として等しいのに文字列が違う。normalize() してから固定小数表記に揃える。
        key=format(abs(mag).normalize(),'f')       # ID は絶対値で振る（符号は外に残す）
        if key not in self.by_mag:
            sid=self._new_id(); self.by_mag[key]=sid; self.by_id[sid]=key
        return self.by_mag[key]
    def mask(self, text, lang):
        out=[]; last=0; used=[]
        for a,b,mag in tokens(text,lang):
            if a<last: continue
            raw=text[a:b]
            sign="".join(ch for ch in raw[:2] if ch in "△▲")   # 符号は残す
            sym=self.sym(mag)
            out.append(text[last:a]); out.append(sign+sym)
            used.append((sym,raw,sign)); last=b
        out.append(text[last:])
        return "".join(out), used
