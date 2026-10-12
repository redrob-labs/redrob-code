"""
Trains the work classifier's head and measures it on the evaluation set.

Reproduce:
    uv pip install -r packages/work-labeller/model/scripts/requirements.txt
    cd packages/work-labeller
    bun model/scripts/export.ts > .model-runs/eval-data.json
    python model/scripts/train.py .model-runs/eval-data.json

The head is softmax regression on a frozen encoder's sentence embeddings, at two levels: the work
family (write, sheet, code, design, or not work) and the kind of work. Training uses the training set
and the prototypes. The confidence floors come from the tuning slice (model/train/tuning.ts),
written like the evaluation set but apart from it: the lowest floor at which the tuning slice reaches
TUNING_PRECISION with TUNING_COVERAGE, chosen before the evaluation set is scored. The evaluation set
is embedded once, at the end, and only scored. Writes the head of the candidate that
passes the most levels (the smaller on a tie) to .model-runs/head.json.
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import evaluate as ev  # noqa: E402

FAMILY = {
    "reply": "write", "summ": "write", "email": "write", "research": "write", "spec": "write",
    "copy": "write", "translate": "write", "policy": "write", "hr": "write",
    "analyze": "sheet", "finance": "sheet",
    "code": "code", "fix": "code", "review": "code", "test": "code",
    "design": "design",
}
SCALE = 20.0
# Five points above the bar: the tuning slice is small (128 work messages), so a floor that only just
# reaches 85% on it would land under 85% about half the time on new data.
TUNING_PRECISION = 0.90
TUNING_COVERAGE = 0.70


def fit(x, labels, epochs=600, lr=0.5, l2=1e-3):
    classes = sorted({l for l in labels if l is not None}) + [None]
    y = np.array([classes.index(l) for l in labels])
    onehot = np.eye(len(classes))[y]
    xs = x * SCALE
    w = np.zeros((x.shape[1], len(classes)))
    b = np.zeros(len(classes))
    for _ in range(epochs):
        logits = xs @ w + b
        logits -= logits.max(axis=1, keepdims=True)
        p = np.exp(logits)
        p /= p.sum(axis=1, keepdims=True)
        grad = p - onehot
        w -= lr * (xs.T @ grad / len(y) + l2 * w)
        b -= lr * grad.mean(axis=0)
    return classes, w, b


def predict(model, x):
    classes, w, b = model
    logits = (x * SCALE) @ w + b
    logits -= logits.max(axis=1, keepdims=True)
    p = np.exp(logits)
    p /= p.sum(axis=1, keepdims=True)
    k = p.argmax(axis=1)
    return [classes[i] for i in k], p[np.arange(len(k)), k]


def floor_for(model, x, labels):
    """The lowest floor at which the tuning slice reaches the tuning precision and coverage."""
    names, conf = predict(model, x)
    work = sum(1 for l in labels if l is not None)
    for floor in np.arange(0.05, 0.96, 0.01):
        named = [(n, l) for n, c, l in zip(names, conf, labels) if n is not None and c >= floor]
        if not named:
            break
        precision = sum(n == l for n, l in named) / len(named)
        coverage = sum(1 for n, l in named if l is not None) / work
        if coverage < TUNING_COVERAGE:
            break
        if precision >= TUNING_PRECISION:
            return float(floor)
    return 0.96


def answer(model, floor, x):
    names, conf = predict(model, x)
    return [n if n is not None and c >= floor else None for n, c in zip(names, conf)]


def score(answers, truths, samples):
    def rates(keep):
        rows = [(a, t, s) for a, t, s in zip(answers, truths, samples) if keep(s)]
        named = [(a, t) for a, t, _ in rows if a is not None]
        work = [(a, t) for a, t, _ in rows if t is not None]
        none = [a for a, t, _ in rows if t is None]
        return {
            "precision": sum(a == t for a, t in named) / len(named) if named else None,
            "coverage": sum(a is not None for a, _ in work) / len(work) if work else None,
            "abstain": sum(a is None for a in none) / len(none) if none else None,
        }

    return {
        "all": rates(lambda s: True),
        "en": rates(lambda s: s["lang"] == "en"),
        "ko": rates(lambda s: s["lang"] == "ko"),
        "hard": rates(lambda s: s["source"] == "hard"),
    }


def bar(result, size_mb, ms):
    a = result["all"]
    fails = []
    if (a["precision"] or 0) < ev.BAR["precision"]:
        fails.append("precision")
    if (a["coverage"] or 0) < ev.BAR["coverage"]:
        fails.append("coverage")
    if (a["abstain"] or 0) < ev.BAR["abstain"]:
        fails.append("abstain")
    if (result["en"]["precision"] or 0) - (result["ko"]["precision"] or 0) > ev.BAR["ko_gap"]:
        fails.append("korean")
    if size_mb > ev.BAR["size_mb"]:
        fails.append("size")
    if ms > ev.BAR["ms"]:
        fails.append("latency")
    return "pass" if not fails else "fail: " + ", ".join(fails)


def main():
    data = json.loads(Path(sys.argv[1]).read_text())
    train = [{"text": p["text"], "action": None if p["learn"] else p["action"]} for p in data["prototypes"]] + [
        {"text": t["text"], "action": None if t["learn"] else t["action"]} for t in data["training"]
    ]
    samples = data["samples"]
    tuning = data["tuning"]
    reports = []
    best = None
    for cid, repo, revision, onnx_file, prefix, _ in ev.CANDIDATES:
        session, tokenizer, size_mb, _, full = ev.load(repo, revision, onnx_file)
        x, _ = ev.embed(session, tokenizer, [t["text"] for t in train], prefix)
        actions = [t["action"] for t in train]
        families = [FAMILY[a] if a else None for a in actions]
        action_model, family_model = fit(x, actions), fit(x, families)
        tx, _ = ev.embed(session, tokenizer, [t["text"] for t in tuning], prefix)
        tuning_actions = [t["action"] for t in tuning]
        action_floor = floor_for(action_model, tx, tuning_actions)
        family_floor = floor_for(family_model, tx, [FAMILY[a] if a else None for a in tuning_actions])
        sx, times = ev.embed(session, tokenizer, [s["text"] for s in samples], prefix)
        ms = float(np.median(times))
        result = {}
        for level, model, floor, truth in (
            ("action", action_model, action_floor, [s["action"] for s in samples]),
            ("family", family_model, family_floor, [FAMILY[s["action"]] if s["action"] else None for s in samples]),
        ):
            r = score(answer(model, floor, sx), truth, samples)
            r["floor"] = round(floor, 2)
            r["bar"] = bar(r, size_mb, ms)
            result[level] = r
        report = {"id": cid, "repo": repo, "revision": full, "file": onnx_file, "size_mb": round(size_mb, 1), "ms": round(ms, 1), **result}
        reports.append(report)
        # The candidate that passes more levels wins; on a tie, the earlier (smaller) one.
        passed = (result["action"]["bar"] == "pass") + (result["family"]["bar"] == "pass")
        if passed and (best is None or passed > best[0]):
            best = (passed, report, action_model, action_floor, family_model, family_floor, prefix)
    print(json.dumps({"bar": ev.BAR, "training": len(train), "tuning": len(tuning), "samples": len(samples), "reports": reports}, indent=1))
    if best:
        _, report, am, af, fm, ff, prefix = best

        def dump(model, floor):
            classes, w, b = model
            return {"classes": classes, "scale": SCALE, "floor": round(floor, 2), "w": np.round(w, 5).tolist(), "b": np.round(b, 5).tolist()}

        head = {
            "encoder": {k: report[k] for k in ("repo", "revision", "file")},
            "prefix": prefix,
            "action": dump(am, af) if report["action"]["bar"] == "pass" else None,
            "family": dump(fm, ff),
        }
        Path(sys.argv[1]).with_name("head.json").write_text(json.dumps(head))


if __name__ == "__main__":
    main()
