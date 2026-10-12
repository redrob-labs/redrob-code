# Route model

The labeller runs [sentence-transformers/distiluse-base-multilingual-cased-v2](https://huggingface.co/sentence-transformers/distiluse-base-multilingual-cased-v2)
at revision `bfe45d0732ca50787611c0fe107ba278c7f3f889` (its Dense projection, `2_Dense/model.safetensors`), with the
int8 ONNX export and tokenizer of [Xenova/distiluse-base-multilingual-cased-v2](https://huggingface.co/Xenova/distiluse-base-multilingual-cased-v2)
at revision `cad454171d918d9873a2701ba245054b6c1760dd`, licensed under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). The files are unmodified; `src/manifest.json` pins each by SHA-256.
