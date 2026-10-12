"""
Measures candidate models for the on-device work classifier against the evaluation set.

Reproduce:
    uv pip install -r packages/work-labeller/model/scripts/requirements.txt
    cd packages/work-labeller && bun model/scripts/export.ts > .model-runs/eval-data.json
    python model/scripts/evaluate.py .model-runs/eval-data.json

Each candidate embeds the prototype phrases (model/prototypes.ts) and each sample
(model/eval/work-samples.ts), and answers with the kind of work of the nearest prototypes,
or nothing when the best match is not clearly better than "not work". The threshold is chosen on the
prototypes alone, never on the samples, so the score is not tuned to the set it is reported on.
"""

import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

CANDIDATES = [
    # id, repo, revision, onnx file, query prefix, pooling
    ("e5-small", "Xenova/multilingual-e5-small", "761b726d", "onnx/model_int8.onnx", "query: ", "mean"),
    ("minilm-l12", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", "2c4055b1", "onnx/model_int8.onnx", "", "mean"),
    ("e5-base", "Xenova/multilingual-e5-base", "1ec92430", "onnx/model_int8.onnx", "query: ", "mean"),
]

# The bar, written down before the first run.
BAR = {
    "precision": 0.85,  # of the kinds of work it names, the share it names correctly
    "coverage": 0.70,  # of messages that are work, the share it names a kind for
    "abstain": 0.70,  # of messages that are not work or too vague, the share it leaves unlabeled
    "ko_gap": 0.10,  # Korean precision no more than this below English
    # Raised from 120 MB on 2026-10-08, by product decision, to ship the kind of work on e5-base (278 MB).
    "size_mb": 300,
    "ms": 50,  # median per message, 2 threads
}

TOP_K = 3


def load(repo, revision, onnx_file):
    full = None
    from huggingface_hub import HfApi

    for ref in HfApi().list_repo_commits(repo):
        if ref.commit_id.startswith(revision):
            full = ref.commit_id
            break
    model = hf_hub_download(repo, onnx_file, revision=full)
    tok = hf_hub_download(repo, "tokenizer.json", revision=full)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    # Basic optimisations only: they are exact, so onnxruntime-node in redrob-server reproduces these
    # embeddings bit for bit. The extended fusions ("all") change int8 numerics by version.
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    started = time.perf_counter()
    session = ort.InferenceSession(model, options, providers=["CPUExecutionProvider"])
    load_ms = (time.perf_counter() - started) * 1000
    tokenizer = Tokenizer.from_file(tok)
    tokenizer.enable_truncation(256)
    return session, tokenizer, Path(model).stat().st_size / 1e6, load_ms, full


def embed(session, tokenizer, texts, prefix):
    names = {i.name for i in session.get_inputs()}
    out = []
    times = []
    for text in texts:
        enc = tokenizer.encode(prefix + text)
        ids = np.array([enc.ids], dtype=np.int64)
        mask = np.array([enc.attention_mask], dtype=np.int64)
        feeds = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in names:
            feeds["token_type_ids"] = np.zeros_like(ids)
        started = time.perf_counter()
        hidden = session.run(None, feeds)[0][0]
        times.append((time.perf_counter() - started) * 1000)
        m = mask[0][:, None].astype(np.float32)
        vec = (hidden * m).sum(0) / m.sum()
        out.append(vec / np.linalg.norm(vec))
    return np.stack(out), times


def scores_by_label(sims, labels):
    """Mean of the top-k similarities per label (an action key, or None for not work)."""
    by = {}
    for label in set(labels):
        idx = [i for i, l in enumerate(labels) if l == label]
        top = np.sort(sims[:, idx], axis=1)[:, -min(TOP_K, len(idx)) :]
        by[label] = top.mean(axis=1)
    return by


def classify(by, margin):
    """The best action when it beats "not work" by at least the margin, else None."""
    actions = [k for k in by if k is not None]
    n = len(next(iter(by.values())))
    answers = []
    for i in range(n):
        best = max(actions, key=lambda a: by[a][i])
        answers.append(best if by[best][i] - by[None][i] >= margin else None)
    return answers


def choose_margin(proto_vecs, proto_labels):
    """Leave-one-out on the prototypes: the margin that best separates work from not work there."""
    sims = proto_vecs @ proto_vecs.T
    np.fill_diagonal(sims, -1.0)
    by = scores_by_label(sims, proto_labels)
    best, best_score = 0.0, -1
    for margin in np.arange(-0.05, 0.15, 0.005):
        answers = classify(by, margin)
        right = sum(1 for a, l in zip(answers, proto_labels) if a == l)
        if right > best_score:
            best, best_score = float(margin), right
    return best


SCALE = 20.0  # cosine-softmax temperature: unit vectors carry too little range for 17 classes


def train_head(vecs, labels, epochs=400, lr=0.5, l2=1e-3):
    """Softmax regression on the prototypes only. Classes: every action, plus None for not work."""
    vecs = vecs * SCALE
    classes = sorted({l for l in labels if l is not None}) + [None]
    y = np.array([classes.index(l) for l in labels])
    w = np.zeros((vecs.shape[1], len(classes)))
    b = np.zeros(len(classes))
    onehot = np.eye(len(classes))[y]
    for _ in range(epochs):
        logits = vecs @ w + b
        logits -= logits.max(axis=1, keepdims=True)
        p = np.exp(logits)
        p /= p.sum(axis=1, keepdims=True)
        grad = p - onehot
        w -= lr * (vecs.T @ grad / len(y) + l2 * w)
        b -= lr * grad.mean(axis=0)
    return classes, w, b


def head_answers(classes, w, b, vecs, min_p):
    logits = (vecs * SCALE) @ w + b
    logits -= logits.max(axis=1, keepdims=True)
    p = np.exp(logits)
    p /= p.sum(axis=1, keepdims=True)
    out = []
    for row in p:
        k = int(row.argmax())
        out.append(classes[k] if classes[k] is not None and row[k] >= min_p else None)
    return out


def choose_floor(vecs, labels):
    """
    The confidence floor, from the prototypes alone: train without each one in turn, record what the
    head said about it and how sure it was, and keep the lowest floor whose held-out precision on
    named kinds of work is at least the bar. Never looks at the evaluation set.
    """
    held = []
    for i in range(len(labels)):
        keep = [j for j in range(len(labels)) if j != i]
        classes, w, b = train_head(vecs[keep], [labels[j] for j in keep])
        logits = (vecs[i : i + 1] * SCALE) @ w + b
        logits -= logits.max()
        p = np.exp(logits[0])
        p /= p.sum()
        k = int(p.argmax())
        held.append((classes[k], float(p[k]), labels[i]))
    for floor in np.arange(0.05, 0.95, 0.01):
        named = [(a, l) for a, conf, l in held if a is not None and conf >= floor]
        if named and sum(a == l for a, l in named) / len(named) >= BAR["precision"]:
            return float(floor)
    return 0.95


METHOD = "nearest"


def evaluate(candidate, data):
    cid, repo, revision, onnx_file, prefix, _ = candidate
    session, tokenizer, size_mb, load_ms, full = load(repo, revision, onnx_file)
    protos = data["prototypes"]
    proto_labels = [None if p["learn"] or p["action"] is None else p["action"] for p in protos]
    proto_vecs, _ = embed(session, tokenizer, [p["text"] for p in protos], prefix)
    margin = choose_margin(proto_vecs, proto_labels)
    samples = data["samples"]
    vecs, times = embed(session, tokenizer, [s["text"] for s in samples], prefix)
    if METHOD == "head":
        margin = choose_floor(proto_vecs, proto_labels)
        classes, w, b = train_head(proto_vecs, proto_labels)
        answers = head_answers(classes, w, b, vecs, margin)
    else:
        by = scores_by_label(vecs @ proto_vecs.T, proto_labels)
        answers = classify(by, margin)

    def rates(keep):
        rows = [(a, s) for a, s in zip(answers, samples) if keep(s)]
        work = [(a, s) for a, s in rows if s["action"] is not None]
        named = [(a, s) for a, s in work if a is not None]
        named_all = [(a, s) for a, s in rows if a is not None]
        none = [(a, s) for a, s in rows if s["action"] is None]
        return {
            "n": len(rows),
            "precision": sum(a == s["action"] for a, s in named_all) / len(named_all) if named_all else None,
            "coverage": len(named) / len(work) if work else None,
            "accuracy": sum(a == s["action"] for a, s in work) / len(work) if work else None,
            "abstain": sum(a is None for a, _ in none) / len(none) if none else None,
        }

    report = {
        "id": f"{cid}/{METHOD}",
        "repo": repo,
        "revision": full,
        "file": onnx_file,
        "size_mb": round(size_mb, 1),
        "load_ms": round(load_ms),
        "ms_median": round(statistics.median(times), 1),
        "margin": round(margin, 3),
        "all": rates(lambda s: True),
        "en": rates(lambda s: s["lang"] == "en"),
        "ko": rates(lambda s: s["lang"] == "ko"),
        "plain": rates(lambda s: s["source"] == "plain"),
        "hard": rates(lambda s: s["source"] == "hard"),
        "confusions": {},
    }
    for a, s in zip(answers, samples):
        if s["action"] and a and a != s["action"]:
            key = f'{s["action"]}->{a}'
            report["confusions"][key] = report["confusions"].get(key, 0) + 1
    a = report["all"]
    fails = []
    if (a["precision"] or 0) < BAR["precision"]:
        fails.append("precision")
    if (a["coverage"] or 0) < BAR["coverage"]:
        fails.append("coverage")
    if (a["abstain"] or 0) < BAR["abstain"]:
        fails.append("abstain")
    if (report["en"]["precision"] or 0) - (report["ko"]["precision"] or 0) > BAR["ko_gap"]:
        fails.append("korean")
    if size_mb > BAR["size_mb"]:
        fails.append("size")
    if report["ms_median"] > BAR["ms"]:
        fails.append("latency")
    report["bar"] = "pass" if not fails else "fail: " + ", ".join(fails)
    return report


def main():
    global METHOD
    data = json.loads(Path(sys.argv[1]).read_text())
    reports = []
    for method in ("nearest", "head"):
        METHOD = method
        reports += [evaluate(c, data) for c in CANDIDATES]
    print(json.dumps({"bar": BAR, "samples": len(data["samples"]), "prototypes": len(data["prototypes"]), "reports": reports}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
