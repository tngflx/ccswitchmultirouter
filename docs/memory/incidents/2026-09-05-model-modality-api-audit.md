# Model modality API audit, 2026-09-05

Public, unauthenticated GET requests were made from the development machine. No
inference requests, account changes, or live configuration writes were performed.
These are current public catalog results, not a reconstruction of an earlier
authenticated model fetch.

| Endpoint | HTTP | Models | Explicit input modalities |
| --- | --- | --- | --- |
| https://openrouter.ai/api/v1/models | 200 | 431 | 431 |
| https://opencode.ai/zen/v1/models | 200 | 71 | 0 |
| https://opencode.ai/zen/go/v1/models | 200 | 35 | 0 |

OpenRouter reported `total_count: 431` and `links.next: null`. All 431 entries
contained context limits and pricing; 428 had nonempty supported-parameter lists.
Its `architecture.input_modalities` declares images for 262 models, text alone
for 157, and text with audio/files but no images for 12. For example,
`openai/gpt-6-astra` declared `["file", "image", "text"]`, text output, and
1,050,000 context tokens. The image-support trio is not a complete modality editor:
models may additionally accept audio, files, or video.

Every entry from both OpenCode endpoints had exactly `id`, `object`, `created`,
and `owned_by`. However, https://models.dev/api.json provides richer OpenCode
catalog records: 102 Zen entries and 35 Go entries all declare input modalities.
Exact ID matches covered 71/71 returned Zen models and 34/35 returned Go models;
`hy3-preview` was the unmatched Go ID. Catalog membership is not proof of account
access or successful inference.

## Owning code and decision

`src-tauri/src/services/model_fetch.rs::extract_input_modalities` omitted the
`architecture` container, discarding OpenRouter's explicit input declaration.
Added that container to the existing parser and a regression covering image
inputs, text inputs with image outputs, and absent input declarations. Output
modalities must never be treated as evidence of image-input support.

The online models.dev enrichment currently imports context windows only. Local
preset bundles can additionally fill missing input capabilities. Thus missing
OpenCode API metadata does not establish that no published metadata exists.
Changing online enrichment policy was not part of this patch.

Reference audit: inspected current main source, recent commits, nearby model-fetch
history, and relevant open/closed PR search results in BigStrongSun/ccswitchmulti
and farion1231/cc-switch. BigStrongSun's parser has the same missing architecture
container; the original repository does not provide a matching modality parser
fix. Original PR #5089 concerns model input modalities but is open. Applied the
small parser correction locally rather than importing an unrelated change.

## Raw evidence

Responses are saved locally under
`C:/Users/felix/AppData/Local/Temp/ccswitch-model-metadata-20260905/`.
SHA-256 hashes:

- `openrouter.json`: `3FEF5EF66AC36E657BCFB6319F3EB8FE2B83B4B049AA52B07A43174EADEB785E`
- `opencode-zen.json`: `9B6EF9329388D90973E22A789B491C0BA87DFC71F284B88D9D597017FF75F580`
- `opencode-go.json`: `0B83F7C9B41F28147062F5611C284BABAEC0DD27B8CF8933BDE29B5AFC16E809`
- `models-dev.json`: `C2276B50CAE3C9B90DAB2D8FC0E9DAC25346780661C2C86205712D1F35CD338B`

Verification results are recorded in the linked journal entry. Live desktop
acceptance requires a user rebuild; the running executable predates the patch.
