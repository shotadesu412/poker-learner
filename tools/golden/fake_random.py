"""テスト用の決定的な乱数（JS 版 static/poker/rng.js の Rng.seeded と完全に同じ列・同じアルゴリズム）。

エンジン・CPU AI・モンテカルロは乱数を使うため、そのままでは Python と JS を1件ずつ比較できない。
そこで Python の random モジュールと treys の Deck のシャッフルをこれに差し替えてベクタを作り、
JS 側も同じ乱数列を同じ順番で読めば、ハンド全体（エクイティの値まで）がビット単位で一致するはず。
乱数を読む順番がずれる移植ミスもこれで検出できる。

- 一様乱数は mulberry32（32bit 演算を JS と同じ結果になるよう再現）
- gauss はテスト専用に「一様乱数12個の和 - 6」で近似する。log/cos を使うと C の libm と
  V8 で最下位ビットがずれる恐れがあるため。本番の JS は Box-Muller（分布は Python と同じ）
"""
import bisect
import contextlib
import itertools
import math
import random as _random_module

M32 = 0xFFFFFFFF


def _imul(a, b):
    return (a * b) & M32


class FakeRandom:
    def __init__(self, seed):
        self.state = seed & M32
        self.count = 0  # 読んだ乱数の個数（ずれた位置の特定に使う）

    def random(self):
        self.count += 1
        self.state = (self.state + 0x6D2B79F5) & M32
        s = self.state
        t = _imul(s ^ (s >> 15), 1 | s)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296

    def uniform(self, a, b):
        return a + (b - a) * self.random()

    def choice(self, seq):
        return seq[math.floor(self.random() * len(seq))]

    def sample(self, population, k):
        a = list(population)
        n = len(a)
        for i in range(k):
            j = i + math.floor(self.random() * (n - i))
            a[i], a[j] = a[j], a[i]
        return a[:k]

    def shuffle(self, x):
        for i in range(len(x) - 1, 0, -1):
            j = math.floor(self.random() * (i + 1))
            x[i], x[j] = x[j], x[i]

    def gauss(self, mu, sigma):
        z = 0.0
        for _ in range(12):
            z += self.random()
        return mu + sigma * (z - 6.0)

    def choices(self, population, weights, k=1):
        assert k == 1
        cum = list(itertools.accumulate(weights))
        total = cum[-1]
        i = bisect.bisect(cum, self.random() * total, 0, len(cum) - 1)
        return [population[i]]


@contextlib.contextmanager
def patched(seed):
    """random モジュールと treys の Deck.shuffle を FakeRandom に差し替える。"""
    from treys import Deck
    fake = FakeRandom(seed)
    names = ["random", "uniform", "choice", "sample", "shuffle", "gauss", "choices"]
    orig = {n: getattr(_random_module, n) for n in names}
    orig_shuffle = Deck.shuffle

    def deck_shuffle(self):
        self.cards = Deck.GetFullDeck()
        fake.shuffle(self.cards)

    try:
        for n in names:
            setattr(_random_module, n, getattr(fake, n))
        Deck.shuffle = deck_shuffle
        yield fake
    finally:
        for n, f in orig.items():
            setattr(_random_module, n, f)
        Deck.shuffle = orig_shuffle
