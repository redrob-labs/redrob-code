# Work classifier encoder

The model this package pins (`src/manifest.json`) is `onnx/model_int8.onnx` and `tokenizer.json` from
[Xenova/multilingual-e5-base](https://huggingface.co/Xenova/multilingual-e5-base) at revision
`1ec9243030a27d1a115d5c340572074c125b58b2`. That is an ONNX export of
[intfloat/multilingual-e5-base](https://huggingface.co/intfloat/multilingual-e5-base), licensed under the MIT License.
The files are unchanged copies, served from the `insights-model-e5-base-2026.10` release of redrob-labs/redrob-cowork.

`src/work-head.json` is trained on top of the encoder by redrob-cowork's `packages/work-labeller/model/scripts/train.py`.
